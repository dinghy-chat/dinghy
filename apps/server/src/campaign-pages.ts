import { and, eq, sql } from "drizzle-orm";
import type { Locale } from "../../../packages/widget/src/shared.ts";
import { type CampaignRow, campaignRows } from "./campaign-checks.ts";
import { composeMessage, enterCampaign, mayEnter, variantOf } from "./campaign-entry.ts";
import { type Count, tally } from "./campaign-results.ts";
import { campaign } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { lockVisitors } from "./journey.ts";
import { lockWorkspace } from "./messages.ts";
import { senderMark, type WidgetOutbound } from "./outbound-delivery.ts";
import { visitorFlags } from "./outbound-rules.ts";

// Page campaigns run in the widget: the loader matches the page's URL and waits the seconds, then
// the chat shows the card. The server stores nothing about the visitor for it until they answer,
// and counts the shows, reads and clicks in the campaign's daily results.

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

/**
 * Whether the campaign may show to this visitor: one who exists is in its audience, and not kept
 * out by its frequency or their opt-out, and every campaign pauses with the workspace's switch. A
 * visitor who does not exist yet sees only a campaign for everyone.
 */
async function showsTo(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string | null,
) {
  if (found.allPaused) return false;
  if (visitorId === null) return found.definition.audience === undefined;
  return mayEnter(tx, workspaceId, found, visitorId);
}

/** The page campaigns the loader watches for this visitor, from its beat. */
export async function pageCampaigns(
  tx: Transaction,
  workspaceId: string,
  visitorId: string | null,
) {
  if (visitorId !== null && (await visitorFlags(tx, workspaceId, visitorId)).optedOut) return [];
  const pages = [];
  for (const found of await livePageCampaigns(tx, workspaceId)) {
    const { trigger } = found.definition;
    if (trigger.type !== "page" || !(await showsTo(tx, workspaceId, found, visitorId))) continue;
    pages.push({ id: found.id, url: trigger.url, seconds: trigger.seconds });
  }
  return pages;
}

/** The campaign that may show to this visitor now, or undefined. */
async function shownCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  visitorId: string | null,
) {
  const [found] = await livePageCampaigns(tx, workspaceId, campaignId);
  if (found === undefined) return undefined;
  if (visitorId !== null && (await visitorFlags(tx, workspaceId, visitorId)).optedOut) {
    return undefined;
  }
  return (await showsTo(tx, workspaceId, found, visitorId)) ? found : undefined;
}

/**
 * The page campaign's card for this visitor, in their language, counted as shown. Null when it may
 * not show to them, or for a place in its control group.
 */
export async function showPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  { visitorId, language }: { visitorId: string | null; language: Locale | null },
): Promise<WidgetOutbound | null> {
  const found = await shownCampaign(tx, workspaceId, campaignId, visitorId);
  if (found === undefined) return null;
  const who = visitorId === null ? { language } : { visitorId };
  const composed = await composeMessage(tx, workspaceId, found, who, {});
  if (typeof composed === "string" || composed.control) return null;
  const { actor, as, variant, body, buttons } = composed;
  await tally(tx, workspaceId, { campaignId, variant, visitorId }, [
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
 * Counts a read of the card, or a press of one of its buttons that opens a page or dismisses it.
 * False when the campaign or the button is not there.
 */
export async function countPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  visitorId: string | null,
  action: { read: true } | { button: number },
): Promise<boolean> {
  const [found] = await livePageCampaigns(tx, workspaceId, campaignId);
  if (found === undefined) return false;
  const variant = visitorId === null ? null : variantOf(found.definition, campaignId, visitorId);
  const counted = { campaignId, variant: variant?.key ?? null, visitorId };
  if ("read" in action) {
    await tally(tx, workspaceId, counted, ["read"]);
    return true;
  }
  const message = variant !== null && "message" in variant ? variant.message : undefined;
  const button = (message ?? found.definition.message).buttons?.[action.button];
  // A value button answers, which counts with the visitor's message.
  if (button === undefined || !("url" in button || "dismiss" in button)) return false;
  const counts: Count[] = "dismiss" in button ? ["dismissed"] : [];
  await tally(tx, workspaceId, counted, counts, button.value);
  return true;
}

/**
 * The visitor answers a page campaign's card: its message comes in as an outbound message they
 * read, so it goes in the conversation before the answer. Null when the campaign may no longer
 * reach them, and the answer goes in alone.
 */
export async function answerPageCampaign(
  tx: Transaction,
  workspaceId: string,
  campaignId: string,
  visitorId: string,
): Promise<string | null> {
  const found = await shownCampaign(tx, workspaceId, campaignId, visitorId);
  if (found === undefined) return null;
  await lockVisitors(tx, workspaceId, [visitorId]);
  const { botsPaused } = await lockWorkspace(tx, workspaceId);
  const entry = await enterCampaign(tx, workspaceId, found, visitorId, {
    botsPaused,
    input: { fromPage: true },
  });
  return entry.kind === "entered" ? entry.row.id : null;
}
