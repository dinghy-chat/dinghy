import { and, eq } from "drizzle-orm";
import type { Locale } from "../../../packages/widget/src/shared.ts";
import { audiencesMatched, type CampaignRow, campaignRows, triggerIs } from "./campaign-checks.ts";
import {
  composeMessage,
  enterCampaign,
  frequencyBlocked,
  frequencyBlocker,
  variantAndButtons,
} from "./campaign-entry.ts";
import type { CampaignCount } from "./campaign-parts.ts";
import { sendsEmail } from "./campaign-parts.ts";
import { tally } from "./campaign-results.ts";
import { campaign } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { lockForSend } from "./journey.ts";
import { senderMark, type WidgetOutbound } from "./outbound-delivery.ts";
import { decide, isMember, keyState, situation, visitorFlags } from "./outbound-rules.ts";

// Page campaigns run in the widget: the loader matches the page's URL and waits the seconds, then
// the chat shows the card. The server stores nothing about the visitor for it until they answer,
// and counts the shows, reads and clicks in the campaign's daily results.

/** Who sees a card, and the language the widget shows it in. The visitor may not exist yet. */
interface Viewer {
  visitorId: string | null;
  language: Locale | null;
}

type Card = Exclude<Awaited<ReturnType<typeof composeMessage>>, string>;

/** The live page campaigns, or the one with this ID. */
const livePageCampaigns = (tx: Transaction, workspaceId: string, campaignId?: string) =>
  campaignRows(
    tx,
    workspaceId,
    and(
      eq(campaign.status, "live"),
      triggerIs("page"),
      campaignId === undefined ? undefined : eq(campaign.id, campaignId),
    ),
  );

/** Whether the send's one decision lets the card go now, alone or in their open conversation. */
async function mayGo(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  viewer: Viewer,
  card: Card,
) {
  const { actor, as } = card;
  const draft = {
    id: null,
    visitorId: viewer.visitorId,
    campaignId: found.id,
    fromCode: false,
    unless: null,
    authorApiKeyId: actor.kind === "key" ? actor.apiKeyId : null,
    senderOperatorId: as.senderOperatorId,
  };
  const message = {
    ...draft,
    senderKind: as.senderKind,
    ifConversationOpen: found.definition.presentation.ifConversationOpen,
    sendEmail: sendsEmail(found.definition.delivery),
  };
  const state = await situation(tx, workspaceId, draft, {
    botsPaused: false,
    atSendTime: true,
    found,
  });
  const { kind } = decide(message, state);
  return kind === "go" || kind === "join";
}

/**
 * A visitor who does not exist yet sees only a campaign for everyone with no A/B variants, as an
 * answer picks the variant from the ID they get then.
 */
const forAnyone = ({ definition }: CampaignRow) =>
  definition.audience === undefined && definition.variants === undefined;

/**
 * The card for this viewer, when the campaign's frequency lets them in and the send's decision,
 * which checks the audience, lets it go.
 */
async function cardFor(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  viewer: Viewer,
): Promise<Card | null> {
  const { visitorId, language } = viewer;
  const isKeptOut =
    visitorId === null
      ? !forAnyone(found)
      : (await frequencyBlocker(tx, workspaceId, found, visitorId)) !== null;
  if (isKeptOut) return null;
  const card = await composeMessage(tx, workspaceId, found, visitorId, { language });
  if (typeof card === "string" || card.control) return null;
  return (await mayGo(tx, workspaceId, found, viewer, card)) ? card : null;
}

/** The live page campaigns whose audience and frequency let the visitor in. */
async function lettingIn(tx: Transaction, workspaceId: string, visitorId: string | null) {
  const live = (await livePageCampaigns(tx, workspaceId)).filter((one) => !one.allPaused);
  if (visitorId === null) return live.filter(forAnyone);
  const matched = await audiencesMatched(
    tx,
    workspaceId,
    visitorId,
    live.map((one) => one.definition),
  );
  const blocked = await frequencyBlocked(tx, workspaceId, live, visitorId);
  return live.filter((one, index) => matched[index] === true && !blocked.has(one.id));
}

/**
 * The page campaigns the loader watches for this visitor, from its beat: only those that let them
 * in, as the show runs the send's whole decision. A few reads in all, whatever their number, as
 * every open tab beats.
 */
export async function pageCampaigns(
  tx: Transaction,
  workspaceId: string,
  visitorId: string | null,
) {
  if (visitorId !== null) {
    const { blocked, optedOut } = await visitorFlags(tx, workspaceId, visitorId);
    if (blocked || optedOut) return [];
  }
  return (await lettingIn(tx, workspaceId, visitorId)).flatMap(({ id, definition }) =>
    definition.trigger.type === "page"
      ? [{ id, url: definition.trigger.url, seconds: definition.trigger.seconds }]
      : [],
  );
}

/**
 * The page campaign's card for this viewer, in the widget's language, counted as shown. Null when
 * it may not show to them, or for a place in its control group.
 */
export async function showPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  viewer: Viewer,
): Promise<WidgetOutbound | null> {
  const [found] = await livePageCampaigns(tx, workspaceId, campaignId);
  const card = found === undefined ? null : await cardFor(tx, workspaceId, found, viewer);
  if (found === undefined || card === null) return null;
  const { actor, as, variant, body, buttons } = card;
  await tally(tx, workspaceId, { campaignId, variant, visitorId: viewer.visitorId }, [
    "entered",
    "sent",
    "delivered",
  ]);
  return {
    id: campaignId,
    campaignId,
    body,
    buttons,
    show: found.definition.presentation.show,
    authorOperatorId: actor.kind === "operator" ? actor.operatorId : null,
    authorApiKeyId: actor.kind === "key" ? actor.apiKeyId : null,
    createdAt: new Date(),
    readAt: null,
    outbound: { sender: senderMark(as) },
  };
}

/**
 * Counts a read of the card, or a press of one of its buttons that opens a page or dismisses it,
 * as the card showed them in the viewer's language. False when the campaign or the button is not
 * there.
 */
export async function countPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  viewer: Viewer,
  action: { read: true } | { button: number },
): Promise<boolean> {
  const [found] = await livePageCampaigns(tx, workspaceId, campaignId);
  if (found === undefined) return false;
  const { visitorId, language } = viewer;
  const { variant, buttons } = await variantAndButtons(tx, workspaceId, found, visitorId, language);
  const counted = { campaignId, variant, visitorId };
  if ("read" in action) {
    await tally(tx, workspaceId, counted, ["read"]);
    return true;
  }
  const button = buttons[action.button];
  // A value button answers, which counts with the visitor's message.
  if (button === undefined || !("url" in button || "dismiss" in button)) return false;
  const counts: CampaignCount[] = "dismiss" in button ? ["dismissed"] : [];
  await tally(tx, workspaceId, counted, counts, button.value);
  return true;
}

/** Whether the card's sender may still send it: its key is not revoked, its member is on the team. */
async function senderMaySend(tx: Transaction, workspaceId: string, { actor, as }: Card) {
  if (actor.kind === "key" && (await keyState(tx, workspaceId, actor.apiKeyId)).revoked) {
    return false;
  }
  return as.senderOperatorId === null || isMember(tx, workspaceId, as.senderOperatorId);
}

/**
 * The visitor answers a page campaign's card: its message comes in as an outbound message they
 * read, in the language the card showed, so it goes in the conversation before the answer. The
 * show decided: the answer checks only what makes adding the card unsafe now, as the campaign's
 * end or pause, and the visitor's block or opt-out at its placement. Null when one stops it, and
 * the answer goes in alone.
 */
export async function answerPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  viewer: Viewer & { visitorId: string },
): Promise<string | null> {
  const { visitorId, language } = viewer;
  const { botsPaused } = await lockForSend(tx, workspaceId, [visitorId]);
  // Under the workspace's lock, which an end or a pause takes first, so its status holds.
  const [found] = await livePageCampaigns(tx, workspaceId, campaignId);
  if (found === undefined || found.allPaused) return null;
  const card = await composeMessage(tx, workspaceId, found, visitorId, { language });
  if (typeof card === "string" || card.control) return null;
  if (!(await senderMaySend(tx, workspaceId, card))) return null;
  const entry = await enterCampaign(tx, workspaceId, found, visitorId, {
    botsPaused,
    options: { fromPage: true, language },
  });
  return entry.kind === "entered" ? entry.row.id : null;
}
