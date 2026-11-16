import { and, eq, sql } from "drizzle-orm";
import type { Locale } from "../../../packages/widget/src/shared.ts";
import { type CampaignRow, campaignRows } from "./campaign-checks.ts";
import { composeMessage, enterCampaign, frequencyBlocker } from "./campaign-entry.ts";
import { type Count, tally } from "./campaign-results.ts";
import { sendsEmail } from "./campaign-schemas.ts";
import { campaign } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { lockVisitors } from "./journey.ts";
import { lockWorkspace } from "./messages.ts";
import { senderMark, type WidgetOutbound } from "./outbound-delivery.ts";
import { decide, situation } from "./outbound-rules.ts";

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
      sql`${campaign.definition} #>> '{trigger,type}' = 'page'`,
      campaignId === undefined ? undefined : eq(campaign.id, campaignId),
    ),
  );

/** What the send's one decision says of the card now, as of a message about to become sent. */
async function verdictOf(
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
  const state = await situation(tx, workspaceId, draft, { botsPaused: false, atSendTime: true });
  return decide(message, state).kind;
}

/**
 * The card for this viewer, when it may show now: the frequency lets them in, and the send's
 * decision lets it go. A visitor who does not exist yet sees only a campaign for everyone with no
 * A/B variants, as an answer picks the variant from the ID they get then.
 */
async function cardFor(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  viewer: Viewer,
): Promise<Card | null> {
  const { audience, variants } = found.definition;
  const { visitorId, language } = viewer;
  if (visitorId === null && (audience !== undefined || variants !== undefined)) return null;
  if (visitorId !== null && (await frequencyBlocker(tx, workspaceId, found, visitorId)) !== null) {
    return null;
  }
  const card = await composeMessage(tx, workspaceId, found, visitorId, { language });
  if (typeof card === "string" || card.control) return null;
  return (await verdictOf(tx, workspaceId, found, viewer, card)) === "go" ? card : null;
}

/** The page campaigns the loader watches for this visitor, from its beat. */
export async function pageCampaigns(
  tx: Transaction,
  workspaceId: string,
  visitorId: string | null,
) {
  const pages = [];
  for (const found of await livePageCampaigns(tx, workspaceId)) {
    const { trigger } = found.definition;
    if (trigger.type !== "page") continue;
    if ((await cardFor(tx, workspaceId, found, { visitorId, language: null })) === null) continue;
    pages.push({ id: found.id, url: trigger.url, seconds: trigger.seconds });
  }
  return pages;
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
  const card = await composeMessage(tx, workspaceId, found, visitorId, { language });
  if (typeof card === "string") return false;
  const counted = { campaignId, variant: card.variant, visitorId };
  if ("read" in action) {
    await tally(tx, workspaceId, counted, ["read"]);
    return true;
  }
  const button = card.buttons[action.button];
  // A value button answers, which counts with the visitor's message.
  if (button === undefined || !("url" in button || "dismiss" in button)) return false;
  const counts: Count[] = "dismiss" in button ? ["dismissed"] : [];
  await tally(tx, workspaceId, counted, counts, button.value);
  return true;
}

/**
 * The visitor answers a page campaign's card: its message comes in as an outbound message they
 * read, in the language the card showed, so it goes in the conversation before the answer. Null
 * when the campaign may no longer reach them, and the answer goes in alone.
 */
export async function answerPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  viewer: Viewer & { visitorId: string },
): Promise<string | null> {
  const [found] = await livePageCampaigns(tx, workspaceId, campaignId);
  if (found === undefined) return null;
  const { visitorId, language } = viewer;
  await lockVisitors(tx, workspaceId, [visitorId]);
  const { botsPaused } = await lockWorkspace(tx, workspaceId);
  const card = await composeMessage(tx, workspaceId, found, visitorId, { language });
  if (typeof card === "string" || card.control) return null;
  // The answer starts their conversation or joins the open one, as its presentation allows.
  const verdict = await verdictOf(tx, workspaceId, found, viewer, card);
  if (verdict !== "go" && verdict !== "join") return null;
  const entry = await enterCampaign(tx, workspaceId, found, visitorId, {
    botsPaused,
    options: { fromPage: true, language },
  });
  return entry.kind === "entered" ? entry.row.id : null;
}
