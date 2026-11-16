import { createHash } from "node:crypto";
import { and, eq, gt, isNotNull, or } from "drizzle-orm";
import { LOCALES, type Locale, MESSAGE_MAX } from "../../../packages/widget/src/shared.ts";
import { renderTemplate } from "../../../packages/widget/src/template.ts";
import { type CampaignRow, newestMessage, reachedContact } from "./campaign-checks.ts";
import {
  type CampaignDefinition,
  type CampaignMessage,
  sendsEmail,
  variantMessage,
} from "./campaign-schemas.ts";
import { outboundMessage, visitor } from "./db/schema.ts";
import type { Transaction } from "./db/tenant.ts";
import { toMs } from "./inputs.ts";
import { type Author, placeOutbound, type SendRefusal, sendsAs } from "./outbound-place.ts";
import { keyState } from "./outbound-rules.ts";

// A contact entering a campaign: its frequency, its A/B variant, its text in the contact's
// language with the variables filled, and then the one way any outbound message is made.

type Row = typeof outboundMessage.$inferSelect;
type Variant = NonNullable<CampaignDefinition["variants"]>[number];

/** How a contact enters a campaign: what set it off, and what its text's variables read. */
export interface EntryOptions {
  /** The time before it goes, from the trigger. */
  delay?: string | undefined;
  runId?: string | null;
  /** The ID of a send from code, which a retry finds. Only a send from code has one. */
  clientId?: string;
  data?: Record<string, string | number | boolean> | undefined;
  event?: { properties: Record<string, unknown> } | undefined;
  /** The visitor answers a page campaign's card, which the widget showed and counted. */
  fromPage?: boolean;
  /** The language the widget showed a page campaign's card in, over the contact's own. */
  language?: Locale | null | undefined;
}

export type Entry =
  | { kind: "entered"; row: Row }
  // The message that already counts for the campaign's frequency, or that a retry made.
  | { kind: "existing"; id: string }
  | { kind: "refused"; refusal: SendRefusal };

/** The client ID of a campaign's message, from the one its caller made. */
export const campaignClientId = (campaignId: string, clientId: string) =>
  `campaign:${campaignId}:${clientId}`;

/**
 * The campaign's message that keeps the contact from another one: any for `once`, one within the
 * time for `every`, or one that reached the goal, which ends the campaign for them. A cancelled
 * message does not count, but a place in the control group does.
 */
export async function frequencyBlocker(
  tx: Transaction,
  workspaceId: string,
  found: Pick<CampaignRow, "id" | "definition">,
  visitorId: string,
): Promise<string | null> {
  const { frequency } = found.definition.rules;
  const recent =
    frequency === "once"
      ? reachedContact
      : and(
          reachedContact,
          gt(outboundMessage.createdAt, new Date(Date.now() - toMs(frequency.every))),
        );
  return newestMessage(
    tx,
    workspaceId,
    { campaignId: found.id, visitorId },
    or(recent, isNotNull(outboundMessage.goalReachedAt)),
  );
}

/** The contact's A/B variant: the same one every time, from a hash of the campaign and the contact. */
function variantFor(
  definition: Pick<CampaignDefinition, "variants">,
  campaignId: string,
  visitorId: string,
): Variant | null {
  const { variants } = definition;
  if (variants === undefined) return null;
  const total = variants.reduce((sum, one) => sum + one.weight, 0);
  const hash = createHash("sha256").update(`${campaignId}:${visitorId}`).digest();
  let place = hash.readUInt32BE(0) % total;
  for (const one of variants) {
    if (place < one.weight) return one;
    place -= one.weight;
  }
  throw new Error("The weights do not cover the hash");
}

/** The first word of a name, as the conditions grammar reads `firstName`. */
const firstWord = (name: string | null) => name?.trim().split(/\s+/)[0] || null;

/** The contact's fields that a campaign's text may read, and its language. */
async function contactOf(tx: Transaction, workspaceId: string, visitorId: string) {
  const [found] = await tx
    .select({
      name: visitor.name,
      email: visitor.email,
      userId: visitor.userId,
      language: visitor.locale,
      country: visitor.country,
      timeZone: visitor.timeZone,
      attributes: visitor.attributes,
    })
    .from(visitor)
    .where(and(eq(visitor.workspaceId, workspaceId), eq(visitor.id, visitorId)));
  if (found === undefined) throw new Error("The contact is missing");
  return found;
}

type Contact = Awaited<ReturnType<typeof contactOf>>;

/** Reads one variable of a campaign's text. */
function lookupIn(contact: Contact, options: EntryOptions) {
  const { attributes, ...fields } = contact;
  const scopes: [string, unknown][] = [
    ["attributes.", attributes],
    ["data.", options.data],
    ["event.properties.", options.event?.properties],
  ];
  return (path: string): unknown => {
    if (path === "firstName") return firstWord(contact.name);
    if (Object.hasOwn(fields, path)) return fields[path as keyof typeof fields];
    const [prefix, values] = scopes.find(([prefix]) => path.startsWith(prefix)) ?? [];
    if (prefix === undefined || typeof values !== "object" || values === null) return undefined;
    return (values as Record<string, unknown>)[path.slice(prefix.length)];
  };
}

/** The message in the contact's language, with its variables filled. */
function localized(
  message: CampaignMessage,
  language: string | null,
  lookup: (path: string) => unknown,
) {
  const known = LOCALES.find((one) => one === language);
  const version = (known === undefined ? undefined : message.translations?.[known]) ?? message;
  const body = renderTemplate(version.body, lookup).trim().slice(0, MESSAGE_MAX);
  return {
    // A text whose variables were all empty still says something.
    body: body === "" ? version.body : body,
    buttons: version.buttons ?? message.buttons ?? [],
  };
}

/** The member or key that saved the campaign last, who makes its messages. */
function authorOf(found: Pick<CampaignRow, "authorOperatorId" | "authorApiKeyId">): Author {
  if (found.authorApiKeyId !== null) return { kind: "key", apiKeyId: found.authorApiKeyId };
  if (found.authorOperatorId !== null) {
    return { kind: "operator", operatorId: found.authorOperatorId };
  }
  throw new Error("A campaign has no author");
}

/**
 * The campaign's message for a contact, or for a visitor who does not exist yet: its A/B variant,
 * its text in their language with the variables filled, and who the visitor sees. `control` marks
 * a place in the control group, and a refusal comes when the saver may no longer show its sender.
 */
export async function composeMessage(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string | null,
  options: EntryOptions,
) {
  const { definition } = found;
  const variant = visitorId === null ? null : variantFor(definition, found.id, visitorId);
  const chosen = variantMessage(variant) ?? definition.message;
  const contact = visitorId === null ? null : await contactOf(tx, workspaceId, visitorId);
  const language = options.language ?? contact?.language ?? null;
  const lookup = contact === null ? () => undefined : lookupIn(contact, options);
  const actor = authorOf(found);
  const key = actor.kind === "key" ? await keyState(tx, workspaceId, actor.apiKeyId) : null;
  const as = await sendsAs(tx, workspaceId, actor, key, chosen.sender);
  if (typeof as === "string") return as;
  return {
    variant: variant?.key ?? null,
    control: variant !== null && "control" in variant,
    ...localized(chosen, language, lookup),
    actor,
    as,
  };
}

/**
 * Puts the contact in the campaign: a message made now or after the trigger's delay, unless its
 * frequency keeps them out. A control group's contact gets a row with no text, and a page
 * campaign's card that the visitor answers comes in read, as the widget counted it already. The
 * caller holds the visitor's lock, then the workspace's.
 */
export async function enterCampaign(
  tx: Transaction,
  workspaceId: string,
  found: CampaignRow,
  visitorId: string,
  { botsPaused, options }: { botsPaused: boolean; options: EntryOptions },
): Promise<Entry> {
  const blocker = await frequencyBlocker(tx, workspaceId, found, visitorId);
  if (blocker !== null) return { kind: "existing", id: blocker };
  const composed = await composeMessage(tx, workspaceId, found, visitorId, options);
  if (typeof composed === "string") return { kind: "refused", refusal: composed };
  const { presentation, delivery } = found.definition;
  const sendAt = new Date(Date.now() + (options.delay === undefined ? 0 : toMs(options.delay)));
  const placed = await placeOutbound(
    tx,
    {
      workspaceId,
      visitorId,
      actor: composed.actor,
      via: null,
      as: composed.as,
      input: {
        clientId: campaignClientId(found.id, options.clientId ?? crypto.randomUUID()),
        body: composed.body,
        buttons: composed.buttons,
        ...presentation,
        assignOnReply: delivery.assignOnReply,
        sendEmail: sendsEmail(delivery),
      },
      times: {
        sendAt,
        expiresAt:
          delivery.expiresIn === undefined
            ? null
            : new Date(sendAt.getTime() + toMs(delivery.expiresIn)),
      },
      campaign: {
        id: found.id,
        runId: options.runId ?? null,
        variant: composed.variant,
        kind: composed.control ? "control" : options.fromPage === true ? "page" : "message",
        fromCode: options.clientId !== undefined,
      },
    },
    botsPaused,
  );
  return typeof placed === "string"
    ? { kind: "refused", refusal: placed }
    : { kind: "entered", row: placed };
}
