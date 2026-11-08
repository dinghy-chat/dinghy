// One schema for core and the cloud, with generated migrations. Tables and columns marked "Cloud
// only" are written only by Dinghy Cloud's code in ee/, and stay empty or at their defaults on a
// self-hosted install.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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

export const memberRole = pgEnum("member_role", ["owner", "admin", "agent"]);
export const conversationStatus = pgEnum("conversation_status", ["open", "closed"]);
export const messageKind = pgEnum("message_kind", ["text", "image"]);
export const alertChannel = pgEnum("alert_channel", ["push", "email"]);
export const alertOutcome = pgEnum("alert_outcome", ["sent", "skipped", "failed"]);

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
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
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
    // User context signed by the host backend, for operators to read.
    claims: jsonb("claims"),
    // The issue time of the token that last set the email and claims.
    identityIssuedAt: bigint("identity_issued_at", { mode: "bigint" }),
    // The position this visitor has read up to, so the unread count survives a page load.
    lastReadSeq: bigint("last_read_seq", { mode: "bigint" }).notNull().default(sql`0`),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    // A keyed hash of a signed-out visitor's latest address, so a block can reach a cleared browser.
    lastIpHash: text("last_ip_hash"),
    // When a signed-out visitor's browser token was last used, to a day. One unused for a year stops
    // working. A visitor from before this column counts from the upgrade.
    tokenUsedAt: timestamp("token_used_at", { withTimezone: true }).notNull().defaultNow(),
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
    check(
      "message_one_author",
      sql`num_nonnulls(${table.authorOperatorId}, ${table.authorVisitorId}) = 1`,
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
    unique("message_seq_key").on(table.workspaceId, table.seq),
    index("message_conversation_idx").on(table.workspaceId, table.conversationId, table.seq),
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

/** The payload of a `message.created` event, which the alert fan-out reads back. */
export interface MessageCreatedPayload {
  messageId: string;
  conversationId: string;
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
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index("event_needs_alert_idx").on(table.createdAt).where(sql`${table.needsAlert}`),
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

/** An invite link. Only the token's hash is stored, and it works once. */
export const invite = pgTable(
  "invite",
  {
    workspaceId: workspaceId(),
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    role: memberRole("role").notNull(),
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
  // The widget is off and operators cannot write from here on. Deletion follows after 30 days.
  readOnlyAt: timestamp("read_only_at", { withTimezone: true }),
  // The latest lifecycle email sent to the owners, so a later pass does not send it again.
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
