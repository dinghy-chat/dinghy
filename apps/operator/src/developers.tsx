/** @jsxImportSource react */
import { useState } from "react";
import {
  type ApiKey,
  type ApiKeyLevel,
  type ReplyMode,
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookTest,
  type WorkspaceApi,
} from "./api.ts";
import { REPLY_MODE_HELP, REPLY_MODES } from "./bots.tsx";
import { useLoad } from "./load.ts";
import { Confirm, Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import {
  AddForm,
  Choices,
  CopyField,
  ErrorNote,
  Field,
  failureText,
  type Option,
  Page,
  PageRow,
  StatusNote,
} from "./ui.tsx";

const MAX_WEBHOOKS = 5;
/** The server's limits on a key's name and a webhook's address. */
const API_KEY_NAME_MAX_LENGTH = 60;
const WEBHOOK_URL_MAX_LENGTH = 2000;

const EVENT_TEXT: Record<WebhookEvent, TextId> = {
  "conversation.created": "webhookEventCreated",
  "message.created": "webhookEventMessage",
  "message.updated": "webhookEventEdited",
  "message.deleted": "webhookEventDeleted",
  "conversation.closed": "webhookEventClosed",
  "conversation.reopened": "webhookEventReopened",
  "conversation.assigned": "webhookEventAssigned",
  "conversation.handoff": "webhookEventHandoff",
  "conversation.bot_resumed": "webhookEventBotResumed",
  "note.created": "webhookEventNote",
};

const DELIVERY_TEXT: Record<WebhookDelivery["status"], TextId> = {
  pending: "deliveryPending",
  sent: "deliverySent",
  failed: "deliveryFailed",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * One line of the key list: the app's host, who made the key or approved the app, and when it was
 * last used.
 */
function apiKeyLine(key: ApiKey): string {
  const date = when(key.createdAt);
  const app = key.source === "oauth";
  const made =
    key.createdByName === null
      ? t(app ? "grantApproved" : "apiKeyMade", { date })
      : t(app ? "grantApprovedBy" : "apiKeyMadeBy", { name: key.createdByName, date });
  const used =
    key.lastUsedAt === null
      ? t("apiKeyNeverUsed")
      : t("apiKeyUsed", { date: when(key.lastUsedAt) });
  const host = key.clientHost === null ? "" : `${key.clientHost} · `;
  return `${host}${made} ${used}`;
}

/** A key's or an app's reply mode, which saves as soon as it changes. */
function ReplyModeSelect({
  api,
  apiKey,
  onSaved,
  onFailed,
}: {
  api: WorkspaceApi;
  apiKey: ApiKey;
  onSaved(key: ApiKey): void;
  onFailed(error: unknown): void;
}) {
  return (
    <Select<ReplyMode>
      label={t("replyModeFor", { name: apiKey.name })}
      value={apiKey.replyMode}
      choices={REPLY_MODES.map((mode) => ({ value: mode.value, label: t(mode.label) }))}
      side="end"
      onChange={(replyMode) =>
        void api.setReplyMode(apiKey.id, replyMode).then((saved) => {
          onSaved(saved);
          toast("saved");
        }, onFailed)
      }
    />
  );
}

const LEVELS: Option<ApiKeyLevel>[] = [
  { value: "conversations", label: "apiKeyLevelConversations" },
  { value: "setup", label: "apiKeyLevelSetup" },
];
const LEVEL_HELP: Record<ApiKeyLevel, TextId> = {
  conversations: "apiKeyLevelConversationsHelp",
  setup: "apiKeyLevelSetupHelp",
};

/** Owners and admins make keys for scripts and AI agents, and revoke them. */
function ApiKeysRow({ api }: { api: WorkspaceApi }) {
  const keys = useLoad(() => api.apiKeys(), [api]);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<ApiKeyLevel>("conversations");
  const [replyMode, setReplyMode] = useState<ReplyMode>("draft");
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // The new key's form shows only once the owner asks for it.
  const [adding, setAdding] = useState(false);

  const act = async (work: () => Promise<void>) => {
    setFailure(null);
    setBusy(true);
    try {
      await work();
      keys.reload();
    } catch (error) {
      setFailure(failureText(error, {}));
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    act(async () => {
      const { token, ...key } = await api.createApiKey(name.trim(), level, replyMode);
      setMade({ name: key.name, token });
      resetForm();
    });
  const revoke = (key: ApiKey) =>
    act(async () => {
      await api.revokeApiKey(key.id);
      setRevoking(null);
    });

  const resetForm = () => {
    setAdding(false);
    setName("");
    setLevel("conversations");
    setReplyMode("draft");
  };
  const saved = (changed: ApiKey) =>
    keys.setData(
      (current) =>
        current && {
          apiKeys: current.apiKeys.map((one) => (one.id === changed.id ? changed : one)),
        },
    );

  const list = keys.data?.apiKeys ?? [];
  return (
    <PageRow
      title={t("apiKeysTitle")}
      help={t("apiKeysHelp")}
      docs={[
        { path: "api#api-keys", text: "apiDocsLink" },
        { path: "agents", text: "mcpDocsLink" },
      ]}
    >
      {list.length > 0 && (
        <ul className="item-list">
          {list.map((key) => (
            <li key={key.id} className="key-item">
              <span className="who-lines">
                <strong>
                  {key.name}{" "}
                  {key.source === "oauth" && (
                    <span className="chip connected">{t("connectedApp")}</span>
                  )}
                  <span className={key.level === "setup" ? "chip warn" : "chip"}>
                    {t(key.level === "setup" ? "apiKeyLevelSetup" : "apiKeyLevelConversations")}
                  </span>
                </strong>
                <span>{apiKeyLine(key)}</span>
              </span>
              <span className="key-actions">
                <ReplyModeSelect
                  api={api}
                  apiKey={key}
                  onSaved={saved}
                  onFailed={(error) => setFailure(failureText(error, {}))}
                />
                <button
                  type="button"
                  className="pill small danger-soft"
                  aria-label={t("apiKeyRevokeLabel", { name: key.name })}
                  onClick={() => setRevoking(key)}
                >
                  {t("apiKeyRevoke")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {made !== null && (
        <CopyField
          hint={t("shownOnce")}
          label={t("apiKeyCopy", { name: made.name })}
          value={made.token}
        />
      )}
      <AddForm
        isOpen={adding}
        newLabel={t("apiKeyNew")}
        submitLabel={t("apiKeyCreate")}
        canSubmit={!busy && name.trim() !== ""}
        onOpen={() => {
          setMade(null);
          setAdding(true);
        }}
        onCancel={() => {
          resetForm();
          setFailure(null);
        }}
        onSubmit={() => void create()}
      >
        <Field
          label={t("apiKeyName")}
          hint={t("apiKeyNameHint")}
          placeholder={t("apiKeyNamePlaceholder")}
          maxLength={API_KEY_NAME_MAX_LENGTH}
          required
          autoComplete="off"
          value={name}
          onChange={setName}
        />
        <div className="key-level">
          <span className="setting-label">{t("apiKeyLevel")}</span>
          <Choices<ApiKeyLevel>
            label={t("apiKeyLevel")}
            variant="outlined"
            value={level}
            options={LEVELS}
            onChange={setLevel}
          />
          <p className="hint">{t(LEVEL_HELP[level])}</p>
        </div>
        <div className="key-level">
          <span className="setting-label">{t("replyMode")}</span>
          <Choices<ReplyMode>
            label={t("replyMode")}
            variant="outlined"
            value={replyMode}
            options={REPLY_MODES}
            onChange={setReplyMode}
          />
          <p className="hint">{t(REPLY_MODE_HELP[replyMode])}</p>
        </div>
      </AddForm>
      <ErrorNote text={failure ?? keys.failure} />
      {revoking !== null && (
        <Confirm
          title={t("apiKeyRevokeTitle", { name: revoking.name })}
          text={t("apiKeyRevokeText")}
          confirm={t("apiKeyRevoke")}
          disabled={busy}
          onConfirm={() => void revoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      )}
    </PageRow>
  );
}

/** The checkboxes that pick a new webhook's events. Nothing is saved until the form is sent. */
function EventPicker({
  events,
  onChange,
}: {
  events: WebhookEvent[];
  onChange(events: WebhookEvent[]): void;
}) {
  return (
    <fieldset className="events">
      <legend>{t("webhookEvents")}</legend>
      {WEBHOOK_EVENTS.map((kind) => (
        <label className="event-option" key={kind}>
          <input
            type="checkbox"
            checked={events.includes(kind)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? WEBHOOK_EVENTS.filter((one) => one === kind || events.includes(one))
                  : events.filter((one) => one !== kind),
              )
            }
          />
          <span className="event-text">
            {t(EVENT_TEXT[kind])}
            <code>{kind}</code>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Up to this many events show by their code names in a webhook's row. More show as a count. */
const NAMED_EVENTS_MAX = 2;

function EventsSummary({ events }: { events: WebhookEvent[] }) {
  if (events.length > NAMED_EVENTS_MAX)
    return <span>{t("webhookEventCount", { count: events.length })}</span>;
  return <span className="hook-events">{events.join(", ")}</span>;
}

/** The text for a test send's result. */
function testResultText(result: WebhookTest): { ok: boolean; text: string } {
  if (result.delivered) return { ok: true, text: t("webhookTestOk", { status: result.status }) };
  if (result.status !== null) {
    return { ok: false, text: t("webhookTestStatus", { status: result.status }) };
  }
  return { ok: false, text: t("webhookTestError", { error: result.error }) };
}

/** When a delivery went, its attempts, and the last answer's status or error. */
function deliveryLine(row: WebhookDelivery): string {
  return [
    when(row.createdAt),
    t(row.attempts === 1 ? "deliveryAttemptOne" : "deliveryAttempts", { count: row.attempts }),
    row.lastStatus === null ? null : `HTTP ${row.lastStatus}`,
    row.lastError,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function DeliveryItem({ row, onReplay }: { row: WebhookDelivery; onReplay(): void }) {
  return (
    <li className="delivery">
      <span className={`chip${row.status === "failed" ? " warn" : ""}`}>
        {t(DELIVERY_TEXT[row.status])}
      </span>
      <code>{row.type}</code>
      {row.replayOf !== null && <span className="chip">{t("deliveryReplayed")}</span>}
      <span className="quiet">{deliveryLine(row)}</span>
      <button
        type="button"
        className="pill small delivery-replay"
        aria-label={t("deliveryReplayLabel", { type: row.type, date: when(row.createdAt) })}
        onClick={onReplay}
      >
        {t("deliveryReplay")}
      </button>
      {row.responseExcerpt !== null && (
        <details className="excerpt">
          <summary>{t("deliveryExcerpt")}</summary>
          <pre>{row.responseExcerpt}</pre>
        </details>
      )}
    </li>
  );
}

function Deliveries({ api, webhookId }: { api: WorkspaceApi; webhookId: string }) {
  const deliveries = useLoad(() => api.webhookDeliveries(webhookId), [api, webhookId]);
  const [failure, setFailure] = useState<TextId | null>(null);
  const rows = deliveries.data?.deliveries ?? null;
  const replay = (deliveryId: string) => {
    setFailure(null);
    api.replayDelivery(webhookId, deliveryId).then(
      () => {
        toast("deliveryReplayDone");
        deliveries.reload();
      },
      (error: unknown) => setFailure(failureText(error, {})),
    );
  };
  if (deliveries.failure !== null) return <ErrorNote text={deliveries.failure} />;
  if (rows === null) return <p className="quiet">{t("loading")}</p>;
  if (rows.length === 0) return <p className="quiet">{t("deliveriesNone")}</p>;
  return (
    <>
      <ul className="deliveries" aria-label={t("deliveriesTitle")}>
        {rows.map((row) => (
          <DeliveryItem key={row.id} row={row} onReplay={() => replay(row.id)} />
        ))}
      </ul>
      <ErrorNote text={failure} />
    </>
  );
}

type Asking = { kind: "rotate" | "delete"; hook: Webhook } | null;

function WebhookItem({
  api,
  hook,
  onChanged,
  onAsk,
}: {
  api: WorkspaceApi;
  hook: Webhook;
  onChanged(hook: Webhook): void;
  onAsk(asking: Asking): void;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [showing, setShowing] = useState(false);
  const [testing, setTesting] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(failureText(error, { 400: "webhookBadUrl" }));
    }
  };
  return (
    <li className="hook">
      <div className="hook-head">
        <span className="who-lines">
          <strong className="mono hook-url" title={hook.url}>
            {hook.url}
          </strong>
          <EventsSummary events={hook.events} />
          {hook.createdBy !== null && (
            <span>
              {t(hook.createdBy.kind === "key" ? "webhookByKey" : "webhookByOperator", {
                name: hook.createdBy.name,
              })}
            </span>
          )}
        </span>
        <label className="check hook-switch">
          <span className="visually-hidden">{t("webhookEnabledLabel", { url: hook.url })}</span>
          <input
            type="checkbox"
            checked={hook.enabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run(async () => onChanged(await api.changeWebhook(hook.id, { enabled })));
            }}
          />
        </label>
      </div>
      <div className="hook-actions">
        <button
          type="button"
          className="pill small"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            setResult(null);
            void run(async () => setResult(testResultText(await api.testWebhook(hook.id)))).finally(
              () => setTesting(false),
            );
          }}
        >
          {testing ? t("webhookTesting") : t("webhookTest")}
        </button>
        <button
          type="button"
          className="pill small"
          aria-expanded={showing}
          onClick={() => setShowing((current) => !current)}
        >
          {t(showing ? "deliveriesHide" : "deliveriesShow")}
        </button>
        <button
          type="button"
          className="pill small"
          onClick={() => onAsk({ kind: "rotate", hook })}
        >
          {t("webhookRotate")}
        </button>
        <button
          type="button"
          className="pill small danger-soft"
          aria-label={t("webhookDeleteLabel", { url: hook.url })}
          onClick={() => onAsk({ kind: "delete", hook })}
        >
          {t("webhookDelete")}
        </button>
      </div>
      {result !== null && (
        <p className={result.ok ? "note" : "bad"} role="status">
          {result.text}
        </p>
      )}
      <ErrorNote text={failure} />
      {showing && (
        <>
          <Deliveries api={api} webhookId={hook.id} />
          <p className="hint">{t("deliveriesNote")}</p>
        </>
      )}
    </li>
  );
}

/** Owners and admins send the workspace's events to their own servers. */
function WebhooksRow({ api }: { api: WorkspaceApi }) {
  const loaded = useLoad(() => api.webhooks(), [api]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  // The new webhook's form shows only once the owner asks for it.
  const [adding, setAdding] = useState(false);
  const hooks = loaded.data?.webhooks ?? [];

  const act = async (work: () => Promise<void>) => {
    setFailure(null);
    setBusy(true);
    try {
      await work();
      loaded.reload();
    } catch (error) {
      setFailure(failureText(error, { 400: "webhookBadUrl", 409: "webhookLimit" }));
    } finally {
      setBusy(false);
    }
  };

  const closeForm = () => {
    setAdding(false);
    setUrl("");
    setEvents([...WEBHOOK_EVENTS]);
  };
  const add = () =>
    act(async () => {
      const made = await api.createWebhook(url.trim(), events);
      setSecret({ url: made.url, secret: made.secret });
      closeForm();
    });

  const confirmAsked = (current: NonNullable<Asking>) =>
    act(async () => {
      if (current.kind === "rotate") {
        const rotated = await api.rotateWebhookSecret(current.hook.id);
        setSecret({ url: rotated.url, secret: rotated.secret });
      } else {
        await api.deleteWebhook(current.hook.id);
        if (secret?.url === current.hook.url) setSecret(null);
      }
      setAsking(null);
    });

  return (
    <PageRow
      title={t("webhooksTitle")}
      help={t("webhooksHelp")}
      docs={[{ path: "api#webhooks", text: "webhookDocsLink" }]}
    >
      {hooks.length > 0 && (
        <ul className="item-list">
          {hooks.map((hook) => (
            <WebhookItem
              key={hook.id}
              api={api}
              hook={hook}
              onAsk={setAsking}
              // From the latest list, so two saves that finish together both show.
              onChanged={(changed) =>
                loaded.setData(
                  (current) =>
                    current && {
                      webhooks: current.webhooks.map((one) =>
                        one.id === changed.id ? changed : one,
                      ),
                    },
                )
              }
            />
          ))}
        </ul>
      )}
      {secret !== null && (
        <CopyField
          hint={t("shownOnce")}
          label={t("webhookSecretCopy", { url: secret.url })}
          value={secret.secret}
        />
      )}
      {hooks.length >= MAX_WEBHOOKS ? (
        <StatusNote text="webhookLimit" />
      ) : (
        <AddForm
          isOpen={adding}
          newLabel={t("webhookNew")}
          submitLabel={t("webhookAdd")}
          canSubmit={!busy && url.trim() !== "" && events.length > 0}
          onOpen={() => {
            setSecret(null);
            setAdding(true);
          }}
          onCancel={() => {
            closeForm();
            setFailure(null);
          }}
          onSubmit={() => void add()}
        >
          <Field
            label={t("webhookUrl")}
            hint={t("webhookUrlHint")}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={WEBHOOK_URL_MAX_LENGTH}
            value={url}
            onChange={setUrl}
          />
          <EventPicker events={events} onChange={setEvents} />
        </AddForm>
      )}
      <ErrorNote text={failure ?? loaded.failure} />
      <p className="hint">{t("webhookVerifyNote")}</p>
      {asking !== null && (
        <Confirm
          title={t(asking.kind === "rotate" ? "webhookRotateTitle" : "webhookDeleteTitle", {
            url: asking.hook.url,
          })}
          text={t(asking.kind === "rotate" ? "webhookRotateText" : "webhookDeleteText")}
          confirm={t(asking.kind === "rotate" ? "webhookRotate" : "webhookDelete")}
          disabled={busy}
          onConfirm={() => void confirmAsked(asking)}
          onCancel={() => setAsking(null)}
        />
      )}
    </PageRow>
  );
}

/** One switch that stops every key and connected app from replying, for owners and admins. */
function BotsPauseRow({
  paused,
  onChange,
}: {
  paused: boolean;
  onChange: ((paused: boolean) => void) | null;
}) {
  return (
    <PageRow title={t("botsPauseTitle")} help={t("botsPauseHelp")}>
      <label className="check">
        {t("botsPauseToggle")}
        <input
          type="checkbox"
          checked={paused}
          disabled={onChange === null}
          onChange={(event) => onChange?.(event.target.checked)}
        />
      </label>
    </PageRow>
  );
}

/** API & webhooks: what lets other software read and answer chats, or hear about them. */
export function DevelopersPage({
  api,
  botsPaused,
  onBotsPaused,
}: {
  api: WorkspaceApi;
  botsPaused: boolean;
  /** Pauses or resumes every bot. Null for a member. */
  onBotsPaused: ((paused: boolean) => void) | null;
}) {
  return (
    <Page title={t("pageDevelopers")}>
      <BotsPauseRow paused={botsPaused} onChange={onBotsPaused} />
      <ApiKeysRow api={api} />
      <WebhooksRow api={api} />
    </Page>
  );
}
