// One schema for core and the cloud, with generated migrations. Tables and columns marked "Cloud
// only" are written only by Dinghy Cloud's code in ee/, and stay empty or at their defaults on a
// self-hosted install.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const id = () => uuid("id").notNull().default(sql`gen_random_uuid()`);
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspace.id);

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);
export const conversationStatus = pgEnum("conversation_status", ["open", "closed"]);
export const messageKind = pgEnum("message_kind", ["text", "image"]);
export const alertChannel = pgEnum("alert_channel", ["push", "email"]);
export const alertOutcome = pgEnum("alert_outcome", ["sent", "skipped", "failed"]);
export const widgetPosition = pgEnum("widget_position", ["left", "right"]);
export const widgetTheme = pgEnum("widget_theme", ["light", "dark", "auto"]);
export const widgetLauncher = pgEnum("widget_launcher", ["boat", "bubble", "hidden"]);
export const widgetEmailAsk = pgEnum("widget_email_ask", ["off", "after_first", "before_first"]);

export const workspace = pgTable(
  "workspace",
  {
    id: id().primaryKey(),
    name: text("name").notNull(),
    // Public: it goes in the widget snippet, and identifies the workspace to the widget routes.
    publicKey: text("public_key").notNull().unique(),
    // The host backend signs identity tokens with this. Only the operator app may show it.
    signingSecret: text("signing_secret").notNull(),
    // Exact origins, such as https://app.example.com. An empty list allows no site.
    allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
    // Message order contract: each write takes the next value under this row's lock.
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull().default(sql`0`),
    // A restore or an import starts a new generation, and older cursors get a resync.
    feedGeneration: integer("feed_generation").notNull().default(1),
    // Only the cloud sets this false: a cloud signup starts inactive until its payment clears.
    // Every other workspace is active.
    active: boolean("active").notNull().default(true),
    // Cloud only. Set on an early cloud signup, made before the cloud takes payments: the workspace
    // waits for the cloud to open. It is one more inactive state rather than a new status column, so
    // the widget, which serves only active workspaces, stays off with no change, and the lifecycle
    // worker, which acts only on a paid subscription, never sees it. The first payment sets
    // `active` and clears this in one update, and the check below keeps the two from overlapping.
    // So a workspace is active, waiting for payment (neither set) or waiting for the cloud (this).
    waitingSince: timestamp("waiting_since", { withTimezone: true }),
    // Set when the owner deletes it, or when its read-only time ends. Nothing can use it after that,
    // and the worker removes its data, its stored images and then this row.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Set by `chat suspend`. Nobody can send or upload, the widget is off, and operators can read.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    // Why, for the server's admin. Operators do not see it.
    suspendedReason: text("suspended_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    index("workspace_deleted_idx").on(table.deletedAt).where(sql`${table.deletedAt} is not null`),
    check(
      "workspace_waiting_inactive",
      sql`not (${table.active} and ${table.waitingSince} is not null)`,
    ),
  ],
);

// BetterAuth's user table. It is global and holds no tenant data, so it has no policy.
export const operator = pgTable("operator", {
  id: id().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // BetterAuth's own flag. Always true, so BetterAuth never runs its own cleanup of unproven
  // accounts: Dinghy proves a mailbox itself, with `emailProven`.
  emailVerified: boolean("email_verified").notNull().default(true),
  // False for an account nobody has proved owns its email: one imported, or one that joined a server
  // without email. The first link that goes by email sets it, once, and signs out the earlier
  // sessions. Nothing ever sets it back.
  emailProven: boolean("email_proven").notNull().default(true),
  image: text("image"),
  // Part of the picture's address, so a new upload gets a new address past every cache. Null with
  // no picture.
  pictureUpdatedAt: timestamp("picture_updated_at", { withTimezone: true }),
  // Set when the operator deletes their account. The row stays, with its personal data erased, so
  // the messages and member rows that point to it keep working.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Cloud only. When the cloud's welcome email went out, so an account gets it once, whatever it does after.
  welcomedAt: timestamp("welcomed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// BetterAuth's tables. They are global and hold no tenant data, so they have no policy.
export const session = pgTable(
  "session",
  {
    id: id().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: id().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("account_user_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: id().primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const workspaceMember = pgTable(
  "workspace_member",
  {
    workspaceId: workspaceId(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operator.id),
    role: memberRole("role").notNull(),
    // A removed member keeps this row, so history keeps its author.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    alertEmail: boolean("alert_email").notNull().default(false),
    // Cloud only. The member followed the stop link in an onboarding email. Billing emails still go.
    onboardingStoppedAt: timestamp("onboarding_stopped_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.operatorId] }),
    index("workspace_member_operator_idx").on(table.operatorId),
  ],
);

export const visitor = pgTable(
  "visitor",
  {
    workspaceId: workspaceId(),
    id: id(),
    // The host product's user ID, for a signed-in visitor.
    externalId: text("external_id"),
    // The SHA-256 of a signed-out visitor's browser token. The token itself is never stored.
    tokenHash: text("token_hash"),
    email: text("email"),
    // The name the host backend signed, on one line.
    name: text("name"),
    // Custom attributes signed by the host backend, for operators to read.
    attributes: jsonb("attributes"),
    // Unsigned values the host page sent with setContext(), for operators to read. Not verified.
    pageContext: jsonb("page_context"),
    // The issue time of the token that last set the name, email and attributes.
    identityIssuedAt: bigint("identity_issued_at", { mode: "bigint" }),
    // The position this visitor has read up to, so the unread count survives a page load.
    lastReadSeq: bigint("last_read_seq", { mode: "bigint" }).notNull().default(sql`0`),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    // A keyed hash of a signed-out visitor's latest address, so a block can reach a cleared browser.
    lastIpHash: text("last_ip_hash"),
    // When a signed-out visitor's browser token was last used, to a day. One unused for a year stops
    // working. A visitor from before this column counts from the upgrade.
    tokenUsedAt: timestamp("token_used_at", { withTimezone: true }).notNull().defaultNow(),
    // A short line such as "Chrome on macOS", made from the widget's User-Agent, which is not kept.
    device: text("device"),
    // The page the widget last reported, as origin and path, and when.
    lastPage: text("last_page"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    index("visitor_blocked_idx").on(table.workspaceId).where(sql`${table.blockedAt} is not null`),
    unique("visitor_external_id_key").on(table.workspaceId, table.externalId),
    unique("visitor_token_hash_key").on(table.tokenHash),
    // A visitor is signed in or signed out, so one identity can never merge into the other.
    check("visitor_one_identity", sql`num_nonnulls(${table.externalId}, ${table.tokenHash}) = 1`),
  ],
);

export const conversation = pgTable(
  "conversation",
  {
    workspaceId: workspaceId(),
    id: id(),
    visitorId: uuid("visitor_id").notNull(),
    status: conversationStatus("status").notNull().default("open"),
    assigneeOperatorId: uuid("assignee_operator_id"),
    // The page where the visitor started it, as origin and path. Never a query string or hash.
    startedPage: text("started_page"),
    // Cloud only. One side of a welcome chat between a new workspace and Dinghy's own, which
    // analytics leave out. The link below joins the two sides.
    welcome: boolean("welcome").notNull().default(false),
    createdAt: createdAt(),
    // Milliseconds, the precision of a JSON date, so a paging cursor can name a row exactly.
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "conversation_visitor_fk",
      columns: [table.workspaceId, table.visitorId],
      foreignColumns: [visitor.workspaceId, visitor.id],
    }),
    foreignKey({
      name: "conversation_assignee_fk",
      columns: [table.workspaceId, table.assigneeOperatorId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.operatorId],
    }),
    index("conversation_visitor_idx").on(table.workspaceId, table.visitorId),
    // The inbox list: one status, newest activity first, paged by (updated_at, id).
    index("conversation_list_idx").on(table.workspaceId, table.status, table.updatedAt, table.id),
    // Analytics read the conversations started in a period.
    index("conversation_created_idx").on(table.workspaceId, table.createdAt),
  ],
);

export const message = pgTable(
  "message",
  {
    workspaceId: workspaceId(),
    id: id(),
    conversationId: uuid("conversation_id").notNull(),
    // The event's sequence. History sorts by this, because a timestamp does not show commit order.
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    kind: messageKind("kind").notNull(),
    authorOperatorId: uuid("author_operator_id"),
    authorVisitorId: uuid("author_visitor_id"),
    // A reply sent with a workspace API key. The key's name is its author name.
    authorApiKeyId: uuid("author_api_key_id"),
    // Generated by the sender, so a retry cannot create a duplicate.
    clientId: text("client_id").notNull(),
    body: text("body"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "message_conversation_fk",
      columns: [table.workspaceId, table.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }),
    foreignKey({
      name: "message_author_operator_fk",
      columns: [table.workspaceId, table.authorOperatorId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.operatorId],
    }),
    foreignKey({
      name: "message_author_visitor_fk",
      columns: [table.workspaceId, table.authorVisitorId],
      foreignColumns: [visitor.workspaceId, visitor.id],
    }),
    foreignKey({
      name: "message_author_api_key_fk",
      columns: [table.workspaceId, table.authorApiKeyId],
      foreignColumns: [apiKey.workspaceId, apiKey.id],
    }),
    check(
      "message_one_author",
      sql`num_nonnulls(${table.authorOperatorId}, ${table.authorVisitorId}, ${table.authorApiKeyId}) = 1`,
    ),
    unique("message_operator_client_key").on(
      table.workspaceId,
      table.authorOperatorId,
      table.clientId,
    ),
    unique("message_visitor_client_key").on(
      table.workspaceId,
      table.authorVisitorId,
      table.clientId,
    ),
    unique("message_api_key_client_key").on(
      table.workspaceId,
      table.authorApiKeyId,
      table.clientId,
    ),
    unique("message_seq_key").on(table.workspaceId, table.seq),
    index("message_conversation_idx").on(table.workspaceId, table.conversationId, table.seq),
    // The widget's header shows the members who replied last: one short read per member.
    index("message_operator_seq_idx")
      .on(table.workspaceId, table.authorOperatorId, table.seq)
      .where(sql`${table.authorOperatorId} is not null`),
    // Search finds a substring of a message, which only a trigram index can serve. The workspace
    // leads it, so a search reads only its own workspace's entries.
    index("message_workspace_body_trgm_idx").using(
      "gin",
      table.workspaceId,
      table.body.op("gin_trgm_ops"),
    ),
  ],
);

export const attachment = pgTable(
  "attachment",
  {
    workspaceId: workspaceId(),
    id: id(),
    messageId: uuid("message_id").notNull(),
    storageKey: text("storage_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "attachment_message_fk",
      columns: [table.workspaceId, table.messageId],
      foreignColumns: [message.workspaceId, message.id],
    }),
    index("attachment_message_idx").on(table.workspaceId, table.messageId),
    // The cloud's image limit sums a workspace's bytes under the workspace lock: an index-only scan.
    index("attachment_bytes_idx").on(table.workspaceId, table.byteSize),
    // The cloud deletes images after 12 months, oldest first.
    index("attachment_created_idx").on(table.createdAt),
  ],
);

// The ordered feed. Payloads hold IDs, never message text, so a delete removes the content.
/**
 * Every kind of event on a workspace's feed. The operator app branches on them, so a new kind goes
 * here first. The column stays text, so a new kind needs no migration.
 */
const EVENT_KINDS = [
  "message.created",
  "conversation.closed",
  "conversation.reopened",
  "conversation.assigned",
  "conversation.deleted",
  "conversation.moderated",
  "team.changed",
  "billing.changed",
  "workspace.changed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The payload of a `message.created` event, which the alert and webhook fan-outs read back. */
export interface MessageCreatedPayload {
  messageId: string;
  conversationId: string;
  fromVisitor: boolean;
  /** This message started its conversation, so a webhook also gets `conversation.created`. */
  conversationCreated?: boolean;
}

export const event = pgTable(
  "event",
  {
    workspaceId: workspaceId(),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    kind: text("kind").$type<EventKind>().notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    // True until the worker has created this event's delivery rows.
    needsAlert: boolean("needs_alert").notNull().default(false),
    // True until the worker has created this event's webhook deliveries. Set only when the
    // workspace had an enabled webhook at the time.
    needsWebhook: boolean("needs_webhook").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index("event_needs_alert_idx").on(table.createdAt).where(sql`${table.needsAlert}`),
    index("event_needs_webhook_idx").on(table.createdAt).where(sql`${table.needsWebhook}`),
    index("event_created_idx").on(table.createdAt),
  ],
);

/** A temporary block on a signed-out visitor's address, which clearing a browser does not avoid. */
export const ipBlock = pgTable(
  "ip_block",
  {
    workspaceId: workspaceId(),
    ipHash: text("ip_hash").notNull(),
    visitorId: uuid("visitor_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One row per visitor, so unblocking one person at an address does not free another.
    primaryKey({ columns: [table.workspaceId, table.ipHash, table.visitorId] }),
    foreignKey({
      name: "ip_block_visitor_fk",
      columns: [table.workspaceId, table.visitorId],
      foreignColumns: [visitor.workspaceId, visitor.id],
    }).onDelete("cascade"),
    index("ip_block_visitor_idx").on(table.workspaceId, table.visitorId),
    index("ip_block_expires_idx").on(table.expiresAt),
  ],
);

/** A stored file whose row is gone. The worker retries until the object store has deleted it. */
export const storageDeletion = pgTable(
  "storage_deletion",
  {
    workspaceId: workspaceId(),
    id: id(),
    storageKey: text("storage_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    index("storage_deletion_due_idx").on(table.nextAttemptAt),
  ],
);

/** A setting of this whole server. It is global, and holds nothing secret. */
export const instanceSetting = pgTable("instance_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * When a worker last finished a pass, over every worker instance. One row. `/readyz` and `/metrics`
 * show it, so a stalled worker shows while the web role stays green.
 */
export const workerHeartbeat = pgTable(
  "worker_heartbeat",
  {
    id: boolean("id").primaryKey().default(true),
    passedAt: timestamp("passed_at", { withTimezone: true }).notNull(),
  },
  (table) => [check("worker_heartbeat_one_row", sql`${table.id}`)],
);

/**
 * The link in a reply email that opens the conversation on this server. Only the token's hash is
 * stored. It works many times until it expires, and goes with its conversation.
 */
export const chatLink = pgTable(
  "chat_link",
  {
    workspaceId: workspaceId(),
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    visitorId: uuid("visitor_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "chat_link_visitor_fk",
      columns: [table.workspaceId, table.visitorId],
      foreignColumns: [visitor.workspaceId, visitor.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "chat_link_conversation_fk",
      columns: [table.workspaceId, table.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete("cascade"),
    index("chat_link_conversation_idx").on(table.workspaceId, table.conversationId),
    index("chat_link_visitor_idx").on(table.workspaceId, table.visitorId),
    index("chat_link_expires_idx").on(table.expiresAt),
  ],
);

/**
 * A page a visitor who chatted went through, as the widget reported it. Only visitors who already
 * have a conversation get rows, at most 100 each, and the worker deletes rows after 90 days.
 */
export const pageView = pgTable(
  "page_view",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    id: id(),
    visitorId: uuid("visitor_id").notNull(),
    // The page's origin and path. Never a query string or hash.
    path: text("path").notNull(),
    title: text("title"),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "page_view_visitor_fk",
      columns: [table.workspaceId, table.visitorId],
      foreignColumns: [visitor.workspaceId, visitor.id],
    }).onDelete("cascade"),
    index("page_view_visitor_idx").on(table.workspaceId, table.visitorId, table.viewedAt.desc()),
    index("page_view_viewed_idx").on(table.viewedAt),
  ],
);

/** An invite to one email address. Only the token's hash is stored, and it works once. */
export const invite = pgTable(
  "invite",
  {
    workspaceId: workspaceId(),
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    role: memberRole("role").notNull(),
    // Lowercase. Only an operator with this email can use the invite.
    email: text("email").notNull(),
    // The server emailed the token, so nobody else saw it, and opening it proves the mailbox.
    mailed: boolean("mailed").notNull(),
    createdBy: uuid("created_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: uuid("used_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "invite_created_by_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.operatorId],
    }),
    check("invite_not_owner", sql`${table.role} <> 'owner'`),
  ],
);

/**
 * An address that used the stop link in a reply email. It is per address and not per visitor,
 * because a new visitor can type the same stranger's address. It holds a hash, so a stopped address
 * does not stay here in readable form.
 */
export const emailStop = pgTable(
  "email_stop",
  {
    workspaceId: workspaceId(),
    addressHash: text("address_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.addressHash] })],
);

/** One browser on one device. It is global, like a session, because it belongs to the operator. */
export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: id().primaryKey(),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => operator.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("push_subscription_operator_idx").on(table.operatorId)],
);

/** One recipient and channel for one event. Delivery is at-least-once: a crash can repeat a send. */
export const alertDelivery = pgTable(
  "alert_delivery",
  {
    workspaceId: workspaceId(),
    id: id(),
    // No foreign key, because event pruning must not depend on this table.
    eventSeq: bigint("event_seq", { mode: "bigint" }).notNull(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id").notNull(),
    operatorId: uuid("operator_id"),
    visitorId: uuid("visitor_id"),
    channel: alertChannel("channel").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: alertOutcome("outcome"),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "alert_delivery_conversation_fk",
      columns: [table.workspaceId, table.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "alert_delivery_message_fk",
      columns: [table.workspaceId, table.messageId],
      foreignColumns: [message.workspaceId, message.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "alert_delivery_operator_fk",
      columns: [table.workspaceId, table.operatorId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.operatorId],
    }),
    foreignKey({
      name: "alert_delivery_visitor_fk",
      columns: [table.workspaceId, table.visitorId],
      foreignColumns: [visitor.workspaceId, visitor.id],
    }).onDelete("cascade"),
    check(
      "alert_delivery_one_recipient",
      sql`num_nonnulls(${table.operatorId}, ${table.visitorId}) = 1`,
    ),
    unique("alert_delivery_recipient_key")
      .on(table.workspaceId, table.eventSeq, table.channel, table.operatorId, table.visitorId)
      .nullsNotDistinct(),
    index("alert_delivery_due_idx").on(table.nextAttemptAt).where(sql`${table.finishedAt} is null`),
    index("alert_delivery_finished_idx").on(table.finishedAt),
    index("alert_delivery_conversation_idx").on(
      table.workspaceId,
      table.conversationId,
      table.createdAt,
    ),
    index("alert_delivery_visitor_idx").on(table.workspaceId, table.visitorId, table.createdAt),
    // A message delete cascades here, once per message, under the workspace lock.
    index("alert_delivery_message_idx").on(table.workspaceId, table.messageId),
  ],
);

/**
 * A workspace API key, for scripts and AI agents. Only the token's hash is stored, and the token is
 * shown once. A revoked key keeps its row, so the replies it sent keep their author name.
 */
export const apiKey = pgTable(
  "api_key",
  {
    workspaceId: workspaceId(),
    id: id(),
    // The author name visitors and operators see on the key's replies.
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by").notNull(),
    // To a minute, so a busy key does not write on every request.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "api_key_created_by_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.operatorId],
    }),
    check("api_key_name_length", sql`char_length(${table.name}) between 1 and 60`),
  ],
);

/** The kinds of change a webhook can ask for. */
export const WEBHOOK_EVENTS = [
  "conversation.created",
  "message.created",
  "conversation.closed",
  "conversation.reopened",
  "conversation.assigned",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** An address that gets a signed POST for each change it asks for. */
export const webhook = pgTable(
  "webhook",
  {
    workspaceId: workspaceId(),
    id: id(),
    url: text("url").notNull(),
    // Signs each request. It must be kept to sign, so it is stored, and only shown once.
    secret: text("secret").notNull(),
    events: text("events").array().$type<WebhookEvent[]>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.id] })],
);

/** One event for one webhook. Delivery is at-least-once: a crash can repeat a send. */
export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    workspaceId: workspaceId(),
    id: id(),
    webhookId: uuid("webhook_id").notNull(),
    // The same for every webhook and every retry of one change, so a receiver can drop a repeat.
    eventId: uuid("event_id").notNull(),
    type: text("type").$type<WebhookEvent>().notNull(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome").$type<"sent" | "failed">(),
    // The last answer's HTTP status, or the reason no answer came.
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    // When the change happened.
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      name: "webhook_delivery_webhook_fk",
      columns: [table.workspaceId, table.webhookId],
      foreignColumns: [webhook.workspaceId, webhook.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "webhook_delivery_conversation_fk",
      columns: [table.workspaceId, table.conversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "webhook_delivery_message_fk",
      columns: [table.workspaceId, table.messageId],
      foreignColumns: [message.workspaceId, message.id],
    }).onDelete("cascade"),
    // A webhook's recent deliveries, for Settings.
    index("webhook_delivery_webhook_idx").on(table.workspaceId, table.webhookId, table.createdAt),
    index("webhook_delivery_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.finishedAt} is null`),
    index("webhook_delivery_finished_idx").on(table.finishedAt),
    index("webhook_delivery_conversation_idx").on(table.workspaceId, table.conversationId),
    index("webhook_delivery_message_idx").on(table.workspaceId, table.messageId),
  ],
);

/** Cloud only. A workspace's Stripe billing. Stripe holds the truth, and this copies it. */
export const subscription = pgTable("subscription", {
  workspaceId: workspaceId().primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // Stripe's own status, such as active or past_due.
  status: text("status"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  // The owner canceled, and service ends with the paid period.
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  // The first time a payment cleared. A signup that never paid has no lifecycle to run.
  paidAt: timestamp("paid_at", { withTimezone: true }),
  // The first failed payment of a run of failures. A repeat keeps it, and a payment clears it.
  paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
  // The widget is off and operators cannot write from here on. Deletion follows after 90 days.
  readOnlyAt: timestamp("read_only_at", { withTimezone: true }),
  // Unused since lifecycle_email replaced it. The column stays one release, so an instance of the
  // previous release that still runs during a deploy can read it. Drop it in the next release.
  notice: text("notice"),
  // A worker holds this row until then, so two workers do not act on it at once.
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  // Part of the Checkout create's idempotency key, and tagged on each session it makes. Requests at
  // the same moment share one key, so Stripe makes one session.
  checkoutAttempt: integer("checkout_attempt").notNull().default(0),
  // A create under the current attempt got a 5xx, whose session Stripe may still have made. The
  // attempt moves on only once a session tagged with it turns up, or after 10 minutes without one.
  checkoutFailedAt: timestamp("checkout_failed_at", { withTimezone: true }),
  // The workspace is deleted and the worker has expired its Checkouts and canceled its
  // subscriptions since, so the purge may remove this row.
  billingClearedAt: timestamp("billing_cleared_at", { withTimezone: true }),
  // Each write adds one, so a slow webhook cannot overwrite a newer state that it did not read.
  revision: integer("revision").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const lifecycleEmailKind = pgEnum("lifecycle_email_kind", [
  "ready",
  "install",
  "team",
  "check_in",
  "review",
  "cancellation",
  "ending_soon",
  "payment_failed",
  "payment_reminder",
  "payment_last_day",
  "payment_recovered",
  "read_only",
  "welcome_back",
  "deletion_30",
  "deletion_7",
  "deleted",
]);

/**
 * Cloud only. An email to a workspace's owners about its plan, queued when the change that causes
 * it commits and sent by the worker once it is due. The key is the workspace, the kind and the time
 * that starts the occurrence, such as the first failed payment, so each goes once per occurrence.
 */
export const lifecycleEmail = pgTable(
  "lifecycle_email",
  {
    workspaceId: workspaceId(),
    kind: lifecycleEmailKind("kind").notNull(),
    occurrenceAt: timestamp("occurrence_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // A worker holds this row until then, so two workers do not send it at once.
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    // Null while it waits. An email whose reason passed before it was due is deleted instead.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.kind, table.occurrenceAt] }),
    index("lifecycle_email_due_idx").on(table.dueAt).where(sql`${table.sentAt} is null`),
  ],
);

/** Cloud only. A Stripe event that was applied. A repeated delivery does nothing. */
export const stripeEvent = pgTable(
  "stripe_event",
  {
    workspaceId: workspaceId(),
    eventId: text("event_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.eventId] }),
    unique("stripe_event_id_key").on(table.eventId),
  ],
);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

/**
 * The workspace's logo, at most 256 pixels a side and encoded as WebP by the server. It lives in
 * Postgres rather than the object store because it is small, and it does not count as image storage.
 * When it last changed is in `widget_settings`, which the widget reads.
 */
export const workspaceLogo = pgTable("workspace_logo", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  // Always WebP: the server encodes every logo again before it stores it.
  data: bytea("data").notNull(),
});

/**
 * An operator's picture, 128 pixels square and encoded as WebP by the server, as a logo is. It is
 * global, like the operator: one face in every workspace. It does not count as image storage.
 */
export const operatorPicture = pgTable("operator_picture", {
  operatorId: uuid("operator_id")
    .primaryKey()
    .references(() => operator.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
});

/**
 * How the widget looks and what it says, one row per workspace, made with the workspace. It is
 * apart from `workspace`, because each message locks the workspace row, and a save must not wait
 * for that lock or hold it. Null texts and colors mean the widget's own.
 */
export const widgetSettings = pgTable(
  "widget_settings",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspace.id, { onDelete: "cascade" }),
    title: text("title"),
    greeting: text("greeting"),
    away: text("away"),
    // Part of the logo's address, so a new upload gets a new address past every cache. Null with
    // no logo.
    logoUpdatedAt: timestamp("logo_updated_at", { withTimezone: true }),
    // Full hex colors, as the snippet's data-primary and data-accent take them.
    primary: text("primary_color"),
    accent: text("accent_color"),
    position: widgetPosition("position").notNull().default("right"),
    theme: widgetTheme("theme").notNull().default("auto"),
    launcher: widgetLauncher("launcher").notNull().default("boat"),
    // The boat in the open chat. A logo takes its place in the header either way.
    mascot: boolean("mascot").notNull().default(true),
    // Pixels, for the chat's corners and the launcher's.
    radius: smallint("radius").notNull().default(16),
    emailAsk: widgetEmailAsk("email_ask").notNull().default("after_first"),
    // The "Powered by Dinghy" line.
    branding: boolean("branding").notNull().default(true),
  },
  (table) => [
    check("widget_settings_primary_color", sql`${table.primary} ~ '^#[0-9a-f]{6}$'`),
    check("widget_settings_accent_color", sql`${table.accent} ~ '^#[0-9a-f]{6}$'`),
    check("widget_settings_radius", sql`${table.radius} between 0 and 24`),
  ],
);

/**
 * Cloud only. A welcome chat: a new workspace's conversation with Dinghy's founder, and its other
 * side in Dinghy's own workspace. A reply on one side becomes a visitor message on the other. Each
 * workspace sees the row, so either side can find the other. It goes with either conversation.
 */
export const welcomeLink = pgTable(
  "welcome_link",
  {
    customerWorkspaceId: uuid("customer_workspace_id").notNull(),
    customerConversationId: uuid("customer_conversation_id").notNull(),
    founderWorkspaceId: uuid("founder_workspace_id").notNull(),
    founderConversationId: uuid("founder_conversation_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.customerWorkspaceId, table.customerConversationId] }),
    unique("welcome_link_founder_key").on(table.founderWorkspaceId, table.founderConversationId),
    foreignKey({
      name: "welcome_link_customer_fk",
      columns: [table.customerWorkspaceId, table.customerConversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "welcome_link_founder_fk",
      columns: [table.founderWorkspaceId, table.founderConversationId],
      foreignColumns: [conversation.workspaceId, conversation.id],
    }).onDelete("cascade"),
  ],
);
