import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  LABEL_NAME_MAX,
  LOCALES,
  SAVED_REPLY_BODY_MAX,
  SAVED_REPLY_SHORTCUT,
} from "../../../packages/widget/src/shared.ts";
import { SESSION } from "./api-security.ts";
import type { App } from "./app.ts";
import { BadArchiveError, readTar, tarEnd, tarEntry, tarEntryParts } from "./archive.ts";
import { BusinessHoursSchema, readBusinessHours, saveBusinessHours } from "./business-hours.ts";
import { newGeneration } from "./db/migrate.ts";
import {
  apiKey,
  attachment,
  conversation,
  conversationLabel,
  emailStop,
  LABEL_COLORS,
  label,
  MESSAGE_KINDS,
  message,
  operator,
  pageView,
  savedReply,
  visitor,
  widgetLanguage,
  widgetSettings,
  workspace,
  workspaceLogo,
  workspaceMember,
} from "./db/schema.ts";
import { type Database, type Transaction, withWorkspace } from "./db/tenant.ts";
import { errorAnswer, failure, MEMBER_ERRORS } from "./errors.ts";
import { allowedFileName, FILE_TYPE, FILENAME_INPUT_MAX } from "./files.ts";
import { sha256Hex } from "./identity.ts";
import { PUBLIC_IMAGE_MAX_BYTES, processImage, processLogo } from "./images.ts";
import { PAGE_PATH_MAX, PAGE_TITLE_MAX, PageContextSchema } from "./journey.ts";
import { markHistoryRead } from "./messages.ts";
import { type RateLimit, tooManyRequests } from "./rate-limit.ts";
import type { ObjectStore } from "./storage.ts";
import { WidgetSettingsSchema } from "./widget-settings.ts";

const VERSION = 1;
const JSON_NAME = "export.json";
// Files too, under the name archives had when they held only images.
const UPLOAD_PREFIX = "images/";
const INSERT_BATCH = 500;
/** Messages are read and written to JSON this many at a time, so no export holds them all. */
const EXPORT_PAGE = 5000;
// Dates stay as ISO text and sequences as decimal text, because JSON numbers cannot hold a bigint.
const date = z.iso.datetime({ offset: true });
const nullableDate = date.nullable();
const seq = z.string().regex(/^\d{1,18}$/);
const id = z.uuid();

/** An import may come from another machine, so nothing in the file is trusted. */
const ExportFile = z.strictObject({
  version: z.literal(VERSION),
  workspace: z.strictObject({
    id,
    name: z.string().min(1).max(200),
    publicKey: z.string().regex(/^wk_[A-Za-z0-9_-]{1,128}$/),
    allowedOrigins: z.array(z.string().max(300)).max(200),
    eventSeq: seq,
    feedGeneration: z.number().int().min(1).max(999_999_999),
    // A file from before the typing preview, the sound or files in the chat has no key, and each
    // starts on.
    widget: WidgetSettingsSchema.extend({
      typingPreview: z.boolean().default(true),
      sound: z.boolean().default(true),
      transcript: z.boolean().default(true),
      visitorFiles: z.boolean().default(true),
      // English, as a workspace from before languages keeps on upgrade.
      language: z.enum(widgetLanguage.enumValues).default("en"),
    }),
    // A file from before business hours has none, and an install that never saved them has null.
    businessHours: BusinessHoursSchema.nullable().default(null),
    // In base64, or null with no logo. A file from a release before logos has no key at all.
    logo: z
      .base64()
      .max(Math.ceil(PUBLIC_IMAGE_MAX_BYTES / 3) * 4)
      .nullable()
      .default(null),
    createdAt: date,
  }),
  members: z.array(
    z.strictObject({
      id,
      name: z.string().min(1).max(200),
      email: z.email().max(320),
      role: z.enum(["owner", "admin", "member"]),
      removedAt: nullableDate,
      alertEmail: z.boolean(),
      createdAt: date,
    }),
  ),
  // Without their tokens, which never leave the server, so an import has them revoked. They stay
  // so that the replies they sent keep their author name.
  apiKeys: z.array(
    z.strictObject({
      id,
      name: z.string().min(1).max(60),
      createdBy: id,
      lastUsedAt: nullableDate,
      revokedAt: nullableDate,
      createdAt: date,
    }),
  ),
  visitors: z.array(
    z.strictObject({
      id,
      externalId: z.string().max(512).nullable(),
      tokenHash: z.string().max(128).nullable(),
      email: z.string().max(320).nullable(),
      name: z.string().max(100).nullable(),
      attributes: z.unknown(),
      pageContext: PageContextSchema.nullable(),
      identityIssuedAt: seq.nullable(),
      lastReadSeq: seq,
      blockedAt: nullableDate,
      device: z.string().max(100).nullable(),
      lastPage: z.string().max(PAGE_PATH_MAX).nullable(),
      lastSeenAt: nullableDate,
      // A file from before contacts has none of these.
      note: z.string().max(5000).nullable().default(null),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .nullable()
        .default(null),
      timeZone: z.string().max(64).nullable().default(null),
      // A file from before languages has none.
      locale: z.enum(LOCALES).nullable().default(null),
      // A file from before test visitors has none.
      isTest: z.boolean().default(false),
      createdAt: date,
    }),
  ),
  conversations: z.array(
    z.strictObject({
      id,
      visitorId: id,
      status: z.enum(["open", "closed"]),
      assigneeOperatorId: id.nullable(),
      snoozedAt: nullableDate.default(null),
      snoozedUntil: nullableDate.default(null),
      startedPage: z.string().max(PAGE_PATH_MAX).nullable(),
      // A file from before bot handoffs has neither.
      humanSince: nullableDate.default(null),
      handoffByApiKeyId: id.nullable().default(null),
      createdAt: date,
      updatedAt: date,
    }),
  ),
  messages: z.array(
    z.strictObject({
      id,
      conversationId: id,
      seq,
      kind: z.enum(MESSAGE_KINDS),
      authorOperatorId: id.nullable(),
      authorVisitorId: id.nullable(),
      authorApiKeyId: id.nullable(),
      clientId: z.string().max(128),
      body: z.string().max(100_000).nullable(),
      metadata: z.unknown(),
      // Missing from files made before quotes, edits and deletes.
      replyToMessageId: id.nullable().optional(),
      editedAt: date.nullable().optional(),
      deletedAt: date.nullable().optional(),
      readAt: date.nullable().optional(),
      createdAt: date,
    }),
  ),
  attachments: z.array(
    z.union([
      // A file from before files in the chat has no kind, and holds only images.
      z.strictObject({
        id,
        messageId: id,
        createdAt: date,
        kind: z.literal("image").default("image"),
      }),
      z.strictObject({
        id,
        messageId: id,
        createdAt: date,
        kind: z.literal("file"),
        filename: z.string().max(FILENAME_INPUT_MAX),
      }),
    ]),
  ),
  emailStops: z.array(z.strictObject({ addressHash: z.string().max(128), createdAt: date })),
  // A file from before saved replies has none.
  savedReplies: z
    .array(
      z.strictObject({
        id,
        shortcut: z.string().regex(SAVED_REPLY_SHORTCUT),
        body: z.string().max(SAVED_REPLY_BODY_MAX),
        updatedAt: date,
      }),
    )
    .default([]),
  // A file from before labels has neither.
  labels: z
    .array(
      z.strictObject({
        id,
        name: z.string().min(1).max(LABEL_NAME_MAX),
        color: z.enum(LABEL_COLORS),
        createdAt: date,
      }),
    )
    .default([]),
  conversationLabels: z
    .array(z.strictObject({ conversationId: id, labelId: id, createdAt: date }))
    .default([]),
  pageViews: z.array(
    z.strictObject({
      visitorId: id,
      path: z.string().max(PAGE_PATH_MAX),
      title: z.string().max(PAGE_TITLE_MAX).nullable(),
      viewedAt: date,
    }),
  ),
});

type ExportData = z.infer<typeof ExportFile>;
const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());
const dateOrNull = (value: string | null | undefined) => (value == null ? null : new Date(value));

type MessageRow = typeof message.$inferSelect;

/** A note's metadata with the members it mentions named by their IDs on this server. */
function withMappedMentions(metadata: unknown, mapOperator: (exported: string) => string | null) {
  const { mentions, ...rest } = metadata as { mentions?: unknown };
  if (!Array.isArray(mentions)) return metadata;
  return { ...rest, mentions: mentions.map((one) => mapOperator(String(one))) };
}

const messageJson = (row: MessageRow): ExportData["messages"][number] => ({
  id: row.id,
  conversationId: row.conversationId,
  seq: row.seq.toString(),
  kind: row.kind,
  authorOperatorId: row.authorOperatorId,
  authorVisitorId: row.authorVisitorId,
  authorApiKeyId: row.authorApiKeyId,
  clientId: row.clientId,
  body: row.body,
  metadata: row.metadata,
  replyToMessageId: row.replyToMessageId,
  editedAt: isoOrNull(row.editedAt),
  deletedAt: isoOrNull(row.deletedAt),
  readAt: isoOrNull(row.readAt),
  createdAt: iso(row.createdAt),
});

/** The items of the `messages` array, in order, one piece per page of EXPORT_PAGE messages. */
async function messagesJson(tx: Transaction, workspaceId: string): Promise<Buffer[]> {
  const pieces: Buffer[] = [];
  for (let after = -1n; ; ) {
    const page = await tx
      .select()
      .from(message)
      .where(and(eq(message.workspaceId, workspaceId), gt(message.seq, after)))
      .orderBy(asc(message.seq))
      .limit(EXPORT_PAGE);
    if (page.length > 0) {
      const text = page.map((row) => JSON.stringify(messageJson(row))).join(",");
      pieces.push(Buffer.from(pieces.length === 0 ? text : `,${text}`));
    }
    const last = page.at(-1);
    if (last === undefined || page.length < EXPORT_PAGE) return pieces;
    after = last.seq;
  }
}

/** The items of the `pageViews` array, one piece per page of EXPORT_PAGE rows. */
async function pageViewsJson(tx: Transaction, workspaceId: string): Promise<Buffer[]> {
  const pieces: Buffer[] = [];
  for (let after = "00000000-0000-0000-0000-000000000000"; ; ) {
    const page = await tx
      .select()
      .from(pageView)
      .where(and(eq(pageView.workspaceId, workspaceId), gt(pageView.id, after)))
      .orderBy(asc(pageView.id))
      .limit(EXPORT_PAGE);
    if (page.length > 0) {
      const text = page
        .map((row) =>
          JSON.stringify({
            visitorId: row.visitorId,
            path: row.path,
            title: row.title,
            viewedAt: iso(row.viewedAt),
          } satisfies ExportData["pageViews"][number]),
        )
        .join(",");
      pieces.push(Buffer.from(pieces.length === 0 ? text : `,${text}`));
    }
    const last = page.at(-1);
    if (last === undefined || page.length < EXPORT_PAGE) return pieces;
    after = last.id;
  }
}

/**
 * One workspace's data at one moment, as the pieces of its JSON file. The repeatable read means a
 * send cannot split the result. Messages, by far the most rows, go to JSON a page at a time, so
 * the export holds about the file's size and never one string past V8's limit.
 */
async function readWorkspace(
  db: Database,
  workspaceId: string,
): Promise<{ json: Buffer[]; storageKeys: Map<string, string> } | null> {
  return withWorkspace(
    db,
    workspaceId,
    async (tx) => {
      const [space] = await tx.select().from(workspace).where(eq(workspace.id, workspaceId));
      if (space === undefined) return null;
      const [logo] = await tx
        .select({ data: workspaceLogo.data })
        .from(workspaceLogo)
        .where(eq(workspaceLogo.workspaceId, workspaceId));
      const [widget] = await tx
        .select()
        .from(widgetSettings)
        .where(eq(widgetSettings.workspaceId, workspaceId));
      if (widget === undefined) return null;
      const hours = await readBusinessHours(tx, workspaceId);
      const {
        workspaceId: _workspace,
        logoUpdatedAt: _logo,
        customizedAt: _customized,
        ...look
      } = widget;
      const members = await tx
        .select({
          id: operator.id,
          name: operator.name,
          email: operator.email,
          role: workspaceMember.role,
          removedAt: workspaceMember.removedAt,
          alertEmail: workspaceMember.alertEmail,
          createdAt: workspaceMember.createdAt,
        })
        .from(workspaceMember)
        .innerJoin(operator, eq(operator.id, workspaceMember.operatorId))
        .where(eq(workspaceMember.workspaceId, workspaceId));
      const keys = await tx.select().from(apiKey).where(eq(apiKey.workspaceId, workspaceId));
      const visitors = await tx.select().from(visitor).where(eq(visitor.workspaceId, workspaceId));
      const conversations = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.workspaceId, workspaceId));
      const attachments = await tx
        .select()
        .from(attachment)
        .where(eq(attachment.workspaceId, workspaceId));
      const stops = await tx.select().from(emailStop).where(eq(emailStop.workspaceId, workspaceId));
      const replies = await tx
        .select()
        .from(savedReply)
        .where(eq(savedReply.workspaceId, workspaceId));
      const labels = await tx.select().from(label).where(eq(label.workspaceId, workspaceId));
      const onConversations = await tx
        .select()
        .from(conversationLabel)
        .where(eq(conversationLabel.workspaceId, workspaceId));
      // The same bytes as one JSON.stringify of the whole file, in the schema's key order.
      const head: Omit<
        ExportData,
        | "messages"
        | "attachments"
        | "emailStops"
        | "savedReplies"
        | "labels"
        | "conversationLabels"
        | "pageViews"
      > = {
        version: VERSION,
        // The signing secret stays out. An export travels, and that secret signs in any user.
        workspace: {
          id: space.id,
          name: space.name,
          publicKey: space.publicKey,
          allowedOrigins: space.allowedOrigins,
          eventSeq: space.eventSeq.toString(),
          feedGeneration: space.feedGeneration,
          widget: look,
          businessHours: hours ?? null,
          logo: logo === undefined ? null : Buffer.from(logo.data).toString("base64"),
          createdAt: iso(space.createdAt),
        },
        members: members.map((row) => ({
          ...row,
          removedAt: isoOrNull(row.removedAt),
          createdAt: iso(row.createdAt),
        })),
        apiKeys: keys.map((row) => ({
          id: row.id,
          name: row.name,
          createdBy: row.createdBy,
          lastUsedAt: isoOrNull(row.lastUsedAt),
          revokedAt: isoOrNull(row.revokedAt),
          createdAt: iso(row.createdAt),
        })),
        visitors: visitors.map((row) => ({
          id: row.id,
          externalId: row.externalId,
          tokenHash: row.tokenHash,
          email: row.email,
          name: row.name,
          attributes: row.attributes,
          pageContext: PageContextSchema.nullable().catch(null).parse(row.pageContext),
          identityIssuedAt: row.identityIssuedAt?.toString() ?? null,
          lastReadSeq: row.lastReadSeq.toString(),
          blockedAt: isoOrNull(row.blockedAt),
          device: row.device,
          lastPage: row.lastPage,
          lastSeenAt: isoOrNull(row.lastSeenAt),
          note: row.note,
          country: row.country,
          timeZone: row.timeZone,
          locale: row.locale,
          isTest: row.isTest,
          createdAt: iso(row.createdAt),
        })),
        conversations: conversations.map((row) => ({
          id: row.id,
          visitorId: row.visitorId,
          status: row.status,
          assigneeOperatorId: row.assigneeOperatorId,
          snoozedAt: isoOrNull(row.snoozedAt),
          snoozedUntil: isoOrNull(row.snoozedUntil),
          startedPage: row.startedPage,
          humanSince: isoOrNull(row.humanSince),
          handoffByApiKeyId: row.handoffByApiKeyId,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
      };
      const tail: Pick<
        ExportData,
        "attachments" | "emailStops" | "savedReplies" | "labels" | "conversationLabels"
      > = {
        attachments: attachments.map((row) => ({
          id: row.id,
          messageId: row.messageId,
          createdAt: iso(row.createdAt),
          ...(row.filename === null
            ? { kind: "image" as const }
            : { kind: "file" as const, filename: row.filename }),
        })),
        emailStops: stops.map((row) => ({
          addressHash: row.addressHash,
          createdAt: iso(row.createdAt),
        })),
        savedReplies: replies.map((row) => ({
          id: row.id,
          shortcut: row.shortcut,
          body: row.body,
          updatedAt: iso(row.updatedAt),
        })),
        labels: labels.map((row) => ({
          id: row.id,
          name: row.name,
          color: row.color,
          createdAt: iso(row.createdAt),
        })),
        conversationLabels: onConversations.map((row) => ({
          conversationId: row.conversationId,
          labelId: row.labelId,
          createdAt: iso(row.createdAt),
        })),
      };
      const json = [
        Buffer.from(`${JSON.stringify(head).slice(0, -1)},"messages":[`),
        ...(await messagesJson(tx, workspaceId)),
        Buffer.from(`],${JSON.stringify(tail).slice(1, -1)},"pageViews":[`),
        ...(await pageViewsJson(tx, workspaceId)),
        Buffer.from("]}"),
      ];
      return { json, storageKeys: new Map(attachments.map((row) => [row.id, row.storageKey])) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Writes the archive piece by piece, so images and files never all sit in memory. A store that fails ends the
 * stream with an error, and the missing end marker then makes an import refuse the file.
 */
export async function* exportArchive(
  db: Database,
  store: ObjectStore,
  workspaceId: string,
): AsyncGenerator<Uint8Array> {
  const read = await readWorkspace(db, workspaceId);
  if (read === null) throw new Error("The workspace does not exist");
  yield* tarEntryParts(JSON_NAME, read.json);
  for (const [attachmentId, storageKey] of read.storageKeys) {
    const stream = await store.get(storageKey);
    if (stream === null) {
      // Deleted since the read, and then the message simply has none. If its row is still here, the
      // object is missing, as when the store settings are wrong. Going on would lose it.
      const rows = await withWorkspace(db, workspaceId, (tx) =>
        tx
          .select({ id: attachment.id })
          .from(attachment)
          .where(and(eq(attachment.workspaceId, workspaceId), eq(attachment.id, attachmentId))),
      );
      if (rows.length > 0) {
        throw new Error(
          `The stored file for upload ${attachmentId} is missing. Check the storage settings, or restore the file, and try again.`,
        );
      }
      continue;
    }
    const parts: Uint8Array[] = [];
    for await (const part of stream) parts.push(part);
    yield* tarEntry(`${UPLOAD_PREFIX}${attachmentId}`, Buffer.concat(parts));
  }
  yield tarEnd();
}

export class ImportError extends Error {}

interface ImportResult {
  workspaceId: string;
  name: string;
  conversations: number;
  messages: number;
  uploads: number;
  /** Images and files that were deleted while the export ran, so these messages have none. */
  missingUploads: number;
  /** Operators with no account here before this import. They sign in by link. */
  newOperators: string[];
}

/** Postgres class 23 means integrity. The driver's error sits in the cause chain. */
function isConstraintFailure(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && code.startsWith("23")) return true;
  }
  return false;
}

const batches = <T>(rows: T[]): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += INSERT_BATCH) {
    result.push(rows.slice(index, index + INSERT_BATCH));
  }
  return result;
};

type Entries = ReturnType<typeof readTar>;

/** Reads and checks the JSON at the start of the file, before anything is written. */
async function readExportFile(entries: Entries): Promise<ExportData> {
  const first = await entries.next();
  if (first.done || first.value.name !== JSON_NAME) {
    throw new ImportError(`This file has no ${JSON_NAME} at its start.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(first.value.bytes).toString("utf8"));
  } catch {
    throw new ImportError(`${JSON_NAME} is not valid JSON.`);
  }
  const parsed = ExportFile.safeParse(raw);
  if (!parsed.success) {
    throw new ImportError(`${JSON_NAME} does not match this version's format.`);
  }
  const data = parsed.data;
  if (!data.members.some((member) => member.role === "owner" && member.removedAt === null)) {
    throw new ImportError("This export has no active owner.");
  }
  // A counter below an existing sequence would make every later send fail on the unique key.
  const counter = BigInt(data.workspace.eventSeq);
  if (data.messages.some((row) => BigInt(row.seq) > counter)) {
    throw new ImportError("A message's position is past the workspace's counter.");
  }
  return data;
}

/**
 * An entry's bytes as an upload stores them, because this file may have come from anywhere: an
 * image encoded again, and a file as it came, after the same check of its type.
 */
async function checkedUpload(row: ExportData["attachments"][number], bytes: Uint8Array) {
  if (row.kind === "image") {
    const processed = await processImage(bytes);
    if (typeof processed === "string") {
      throw new ImportError(`Image ${row.id} cannot be used: ${processed}.`);
    }
    return processed;
  }
  const filename = allowedFileName(row.filename, bytes);
  if (filename === null) throw new ImportError(`File ${row.id} cannot be used: type_not_allowed.`);
  return { data: bytes, contentType: FILE_TYPE, filename };
}

/**
 * Stores each image and file the archive holds, and records its key in `stored` at once, so a
 * failure can remove what was stored.
 */
async function storeUploads(
  entries: Entries,
  data: ExportData,
  store: ObjectStore,
  stored: string[],
): Promise<(typeof attachment.$inferInsert)[]> {
  const workspaceId = data.workspace.id;
  const wanted = new Map(data.attachments.map((row) => [row.id, row]));
  const uploads: (typeof attachment.$inferInsert)[] = [];
  for await (const { name, bytes } of entries) {
    const attachmentId = name.startsWith(UPLOAD_PREFIX) ? name.slice(UPLOAD_PREFIX.length) : "";
    const row = wanted.get(attachmentId);
    // Exact names only, so an entry cannot name a path outside this workspace's files.
    if (row === undefined) {
      throw new ImportError(`This file has an unexpected entry: ${name.slice(0, 100)}`);
    }
    const { data: checked, ...upload } = await checkedUpload(row, bytes);
    // Unique to this import, so cleaning up a failure cannot touch another import's files.
    const storageKey = `${workspaceId}/${attachmentId}-${randomUUID()}`;
    await store.put(storageKey, checked, upload.contentType);
    stored.push(storageKey);
    uploads.push({
      ...upload,
      workspaceId,
      id: attachmentId,
      messageId: row.messageId,
      storageKey,
      byteSize: checked.length,
      createdAt: new Date(row.createdAt),
    });
  }
  return uploads;
}

/** The file's logo, encoded again as an upload is, because this file may have come from anywhere. */
async function readLogo(data: ExportData): Promise<Buffer | null> {
  if (data.workspace.logo === null) return null;
  const logo = await processLogo(Buffer.from(data.workspace.logo, "base64"));
  if (typeof logo === "string") throw new ImportError(`The logo cannot be used: ${logo}.`);
  return logo;
}

/** Inserts the workspace and its rows. Returns the emails of the operators it created. */
async function insertWorkspace(
  tx: Transaction,
  data: ExportData,
  uploads: (typeof attachment.$inferInsert)[],
  logo: Buffer | null,
): Promise<string[]> {
  const workspaceId = data.workspace.id;
  await tx.insert(workspace).values({
    id: workspaceId,
    name: data.workspace.name,
    publicKey: data.workspace.publicKey,
    signingSecret: randomBytes(32).toString("base64url"),
    allowedOrigins: data.workspace.allowedOrigins,
    eventSeq: BigInt(data.workspace.eventSeq),
    // New and random, so a client's old cursor gets resync, even when one file is imported onto
    // two servers in turn at the same address. A count from the file would repeat there.
    feedGeneration: newGeneration(data.workspace.feedGeneration),
    createdAt: new Date(data.workspace.createdAt),
  });
  await tx.insert(widgetSettings).values({
    ...data.workspace.widget,
    workspaceId,
    logoUpdatedAt: logo === null ? null : new Date(),
  });
  if (logo !== null) {
    await tx.insert(workspaceLogo).values({ workspaceId, data: logo });
  }
  if (data.workspace.businessHours !== null) {
    await saveBusinessHours(tx, workspaceId, data.workspace.businessHours);
  }

  // One email has one login on an install, so an existing account keeps its ID.
  const emails = data.members.map((member) => member.email.toLowerCase());
  const before = await tx
    .select({ id: operator.id, email: operator.email })
    .from(operator)
    .where(inArray(operator.email, emails));
  const known = new Map(before.map((row) => [row.email, row.id]));
  const created: string[] = [];
  const operatorIds = new Map<string, string>();
  for (const member of data.members) {
    const email = member.email.toLowerCase();
    let operatorId = known.get(email);
    if (operatorId === undefined) {
      const [row] = await tx
        .insert(operator)
        .values({ name: member.name, email, emailProven: false })
        .returning({ id: operator.id });
      operatorId = row?.id ?? "";
      created.push(email);
    }
    operatorIds.set(member.id, operatorId);
    await tx.insert(workspaceMember).values({
      workspaceId,
      operatorId,
      role: member.role,
      removedAt: member.removedAt === null ? null : new Date(member.removedAt),
      alertEmail: member.alertEmail,
      createdAt: new Date(member.createdAt),
    });
  }
  const mapOperator = (exported: string | null) => {
    if (exported === null) return null;
    const mapped = operatorIds.get(exported);
    if (mapped === undefined) throw new ImportError("A row names an unknown operator.");
    return mapped;
  };

  // A key's token never travels, so each one comes in revoked, with a hash nothing matches.
  const importedAt = new Date();
  for (const rows of batches(data.apiKeys)) {
    await tx.insert(apiKey).values(
      rows.map((row) => ({
        workspaceId,
        id: row.id,
        name: row.name,
        tokenHash: sha256Hex(`imported:${randomBytes(32).toString("base64url")}`),
        createdBy: mapOperator(row.createdBy) ?? "",
        lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
        revokedAt: row.revokedAt === null ? importedAt : new Date(row.revokedAt),
        createdAt: new Date(row.createdAt),
      })),
    );
  }
  for (const rows of batches(data.visitors)) {
    await tx.insert(visitor).values(
      rows.map((row) => ({
        workspaceId,
        id: row.id,
        externalId: row.externalId,
        tokenHash: row.tokenHash,
        email: row.email,
        name: row.name,
        attributes: row.attributes,
        pageContext: row.pageContext,
        identityIssuedAt: row.identityIssuedAt === null ? null : BigInt(row.identityIssuedAt),
        lastReadSeq: BigInt(row.lastReadSeq),
        blockedAt: row.blockedAt === null ? null : new Date(row.blockedAt),
        device: row.device,
        lastPage: row.lastPage,
        lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt),
        note: row.note,
        country: row.country,
        timeZone: row.timeZone,
        locale: row.locale,
        isTest: row.isTest,
        createdAt: new Date(row.createdAt),
      })),
    );
  }
  for (const rows of batches(data.conversations)) {
    await tx.insert(conversation).values(
      rows.map((row) => ({
        workspaceId,
        id: row.id,
        visitorId: row.visitorId,
        status: row.status,
        assigneeOperatorId: mapOperator(row.assigneeOperatorId),
        snoozedAt: dateOrNull(row.snoozedAt),
        snoozedUntil: dateOrNull(row.snoozedUntil),
        startedPage: row.startedPage,
        humanSince: dateOrNull(row.humanSince),
        handoffByApiKeyId: row.handoffByApiKeyId,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      })),
    );
  }
  for (const rows of batches(data.messages)) {
    await tx.insert(message).values(
      rows.map((row) => ({
        workspaceId,
        id: row.id,
        conversationId: row.conversationId,
        seq: BigInt(row.seq),
        kind: row.kind,
        authorOperatorId: mapOperator(row.authorOperatorId),
        authorVisitorId: row.authorVisitorId,
        authorApiKeyId: row.authorApiKeyId,
        clientId: row.clientId,
        body: row.body,
        metadata: withMappedMentions(row.metadata ?? {}, mapOperator),
        // Messages go in commit order, so a quoted one is always in already.
        replyToMessageId: row.replyToMessageId ?? null,
        editedAt: dateOrNull(row.editedAt),
        deletedAt: dateOrNull(row.deletedAt),
        readAt: dateOrNull(row.readAt),
        createdAt: new Date(row.createdAt),
      })),
    );
  }
  for (const rows of batches(uploads)) await tx.insert(attachment).values(rows);
  for (const rows of batches(data.pageViews)) {
    await tx.insert(pageView).values(
      rows.map((row) => ({
        workspaceId,
        visitorId: row.visitorId,
        path: row.path,
        title: row.title,
        viewedAt: new Date(row.viewedAt),
      })),
    );
  }
  for (const rows of batches(data.savedReplies)) {
    await tx.insert(savedReply).values(
      rows.map((row) => ({
        workspaceId,
        id: row.id,
        shortcut: row.shortcut,
        body: row.body,
        updatedAt: new Date(row.updatedAt),
      })),
    );
  }
  for (const rows of batches(data.labels)) {
    await tx
      .insert(label)
      .values(rows.map((row) => ({ workspaceId, ...row, createdAt: new Date(row.createdAt) })));
  }
  for (const rows of batches(data.conversationLabels)) {
    await tx
      .insert(conversationLabel)
      .values(rows.map((row) => ({ workspaceId, ...row, createdAt: new Date(row.createdAt) })));
  }
  for (const rows of batches(data.emailStops)) {
    await tx.insert(emailStop).values(
      rows.map((row) => ({
        workspaceId,
        addressHash: row.addressHash,
        createdAt: new Date(row.createdAt),
      })),
    );
  }
  return created;
}

/**
 * Adds an exported workspace to this install. It stores the uploads first and commits every row in
 * one transaction, so a failure at any point leaves nothing behind. A workspace that exists here is
 * refused, so a repeated import changes nothing.
 */
export async function importArchive(
  db: Database,
  store: ObjectStore,
  chunks: AsyncIterable<Uint8Array>,
): Promise<ImportResult> {
  const stored: string[] = [];
  // True once only the commit is left. After that a failure may be a lost reply from a commit that
  // worked, and a stray file costs less than rows whose uploads are gone.
  let reachedCommit = false;
  try {
    const entries = readTar(chunks);
    const data = await readExportFile(entries);
    const workspaceId = data.workspace.id;
    const exists = await withWorkspace(db, workspaceId, (tx) =>
      tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)),
    );
    if (exists.length > 0) {
      throw new ImportError(`Workspace ${workspaceId} is already on this server.`);
    }

    const logo = await readLogo(data);
    const uploads = await storeUploads(entries, data, store, stored);
    const newOperators = await withWorkspace(db, workspaceId, async (tx) => {
      const created = await insertWorkspace(tx, data, uploads, logo);
      await markHistoryRead(tx, workspaceId);
      reachedCommit = true;
      return created;
    });
    return {
      workspaceId,
      name: data.workspace.name,
      conversations: data.conversations.length,
      messages: data.messages.length,
      uploads: uploads.length,
      missingUploads: data.attachments.length - uploads.length,
      newOperators,
    };
  } catch (error) {
    if (!reachedCommit) {
      await Promise.all(stored.map((key) => store.delete(key).catch(() => undefined)));
    }
    if (error instanceof BadArchiveError) throw new ImportError(error.message);
    if (isConstraintFailure(error)) {
      throw new ImportError(
        "The file's rows conflict with each other or with this server, such as a public key in use.",
      );
    }
    throw error;
  }
}

const exportRoute = createRoute({
  method: "get",
  path: "/v1/operator/workspaces/{workspaceId}/export",
  security: SESSION,
  summary: "Download this workspace's data, images and files as a tar file. Owners only.",
  request: { params: z.object({ workspaceId: z.uuid() }) },
  responses: {
    200: {
      description: "A tar file with export.json, and the images and files",
      content: { "application/x-tar": { schema: z.string() } },
    },
    ...MEMBER_ERRORS,
    403: errorAnswer("forbidden: only an owner can export"),
    429: errorAnswer("too_many_requests: over 10 exports an hour. Retry after `retry-after`"),
  },
});

export function registerExportRoute(
  app: App,
  db: Database,
  store: ObjectStore,
  rateLimit: RateLimit,
): void {
  app.openapi(exportRoute, async (c) => {
    if (c.get("memberRole") !== "owner") {
      return c.json(failure("forbidden", "Only an owner can export a workspace."), 403);
    }
    const id = c.get("memberWorkspaceId");
    // An export reads every row and every image.
    const wait = await rateLimit.hit("export", id, 10, 3600);
    if (wait !== null) return tooManyRequests(c, wait) as never;
    const stream = Readable.toWeb(Readable.from(exportArchive(db, store, id)));
    return new Response(stream as ReadableStream, {
      headers: {
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="dinghy-export-${id}.tar"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }) as never;
  });
}
