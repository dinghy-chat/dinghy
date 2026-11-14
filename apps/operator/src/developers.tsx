/** @jsxImportSource react */
import { type ReactNode, useState } from "react";
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
import { LEVEL_LABEL, LevelChoice, REPLY_MODES, ReplyModeChoice } from "./bots.tsx";
import { originLine } from "./consent.tsx";
import { MINUTE_MS } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type Loaded, useAction, useLoad } from "./load.ts";
import { Confirm, Select } from "./popup.tsx";
import { ListSkeleton } from "./skeleton.tsx";
import { plural, type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { AddForm, CopyField, ErrorNote, Field, failureText, Page, StatusNote } from "./ui.tsx";
import { ago, bare } from "./visitor.ts";

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
  "conversation.given_back": "webhookEventGivenBack",
  "conversation.labeled": "webhookEventLabeled",
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
const day = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/** A key or app used this recently shows its last use in green. */
const RECENT_USE_MS = 15 * MINUTE_MS;

/** Who made the key or approved the app, and when. */
function madeLine(key: ApiKey): string {
  const date = day(key.createdAt);
  const app = key.source === "oauth";
  return key.createdByName === null
    ? t(app ? "grantApproved" : "apiKeyMade", { date })
    : t(app ? "grantApprovedBy" : "apiKeyMadeBy", { name: key.createdByName, date });
}

/** A key's or an app's row: its mark, name, access, who made it and when it was last used. */
function KeyItem({
  apiKey,
  tools,
  children,
}: {
  apiKey: ApiKey;
  tools: ReactNode;
  children?: ReactNode;
}) {
  const app = apiKey.source === "oauth";
  const used = apiKey.lastUsedAt;
  const isRecent = used !== null && Date.now() - new Date(used).getTime() < RECENT_USE_MS;
  const origin = apiKey.client === null ? null : originLine(apiKey.client);
  return (
    <li className="item-row">
      <span className={app ? "item-ic client" : "item-ic bot"}>
        <Icon name={app ? "terminal" : "robot"} size={20} />
      </span>
      <div className="item-text">
        <strong className="item-name">{apiKey.name}</strong>
        <span className="item-line">
          <span className="lvl">{t(LEVEL_LABEL[apiKey.level])}</span>
          <span>{madeLine(apiKey)}</span>
          {origin !== null && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span>{origin}</span>
            </>
          )}
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span className={isRecent ? "active" : undefined}>
            {used === null ? t("apiKeyNeverUsed") : t("apiKeyUsed", { ago: ago(used) })}
          </span>
        </span>
      </div>
      <div className="item-tools">{tools}</div>
      {children}
    </li>
  );
}

/** A part of the page: a heading, one line on what it is for, an action, and its rows. */
function Section({
  title,
  help,
  action,
  children,
}: {
  title: string;
  help: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sec" aria-label={title}>
      <div className="sec-head">
        <div>
          <h3>{title}</h3>
          <p>{help}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
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

type LoadedKeys = Loaded<{ apiKeys: ApiKey[] }>;

/** A key's or an app's reply mode and its Revoke or Disconnect, which asks first. */
function KeyTools({
  api,
  apiKey,
  onSaved,
  onFailed,
  onRevoke,
}: {
  api: WorkspaceApi;
  apiKey: ApiKey;
  onSaved(key: ApiKey): void;
  onFailed(error: unknown): void;
  onRevoke(): void;
}) {
  const app = apiKey.source === "oauth";
  return (
    <>
      <ReplyModeSelect api={api} apiKey={apiKey} onSaved={onSaved} onFailed={onFailed} />
      <button
        type="button"
        className="pill small danger-soft"
        aria-label={t(app ? "appDisconnectLabel" : "apiKeyRevokeLabel", { name: apiKey.name })}
        onClick={onRevoke}
      >
        {t(app ? "appDisconnect" : "apiKeyRevoke")}
      </button>
    </>
  );
}

/**
 * The keys of one source: the apps that owners and admins approved in the browser, or the keys made
 * here for a bot on a server, which this part also makes.
 */
function KeysSection({
  api,
  keys,
  source,
}: {
  api: WorkspaceApi;
  keys: LoadedKeys;
  source: ApiKey["source"];
}) {
  const app = source === "oauth";
  const [name, setName] = useState("");
  const [level, setLevel] = useState<ApiKeyLevel>("conversations");
  const [replyMode, setReplyMode] = useState<ReplyMode>("draft");
  // The new key's token, shown once in the key's own row.
  const [made, setMade] = useState<{ id: string; name: string; token: string } | null>(null);
  const { busy, failure, setFailure, run: act } = useAction(keys.reload);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // The new key's form shows only once the owner asks for it.
  const [adding, setAdding] = useState(false);

  const resetForm = () => {
    setAdding(false);
    setName("");
    setLevel("conversations");
    setReplyMode("draft");
  };
  const create = () =>
    act(async () => {
      const { token, ...key } = await api.createApiKey(name.trim(), level, replyMode);
      setMade({ id: key.id, name: key.name, token });
      resetForm();
    });
  const revoke = (key: ApiKey) =>
    act(async () => {
      await api.revokeApiKey(key.id);
      setRevoking(null);
    });
  const saved = (changed: ApiKey) =>
    keys.setData(
      (current) =>
        current && {
          apiKeys: current.apiKeys.map((one) => (one.id === changed.id ? changed : one)),
        },
    );

  const list = (keys.data?.apiKeys ?? []).filter((key) => key.source === source);
  const newKey = (
    <button
      type="button"
      className="pill dark"
      onClick={() => {
        setMade(null);
        setAdding(true);
      }}
    >
      <Icon name="plusBold" size={14} />
      {t("apiKeyNew")}
    </button>
  );
  return (
    <Section
      title={t(app ? "appsTitle" : "apiKeysTitle")}
      help={t(app ? "appsHelp" : "apiKeysHelp")}
      action={app || adding ? undefined : newKey}
    >
      {list.length === 0 && keys.data !== null ? (
        <p className="sec-empty">{t(app ? "appsNone" : "apiKeysNone")}</p>
      ) : (
        <ul className="items">
          {list.map((key) => (
            <KeyItem
              key={key.id}
              apiKey={key}
              tools={
                <KeyTools
                  api={api}
                  apiKey={key}
                  onSaved={saved}
                  onFailed={(error) => setFailure(failureText(error, {}))}
                  onRevoke={() => setRevoking(key)}
                />
              }
            >
              {made?.id === key.id && (
                <CopyField
                  hint={t("shownOnce")}
                  label={t("apiKeyCopy", { name: made.name })}
                  value={made.token}
                />
              )}
            </KeyItem>
          ))}
        </ul>
      )}
      {adding && (
        <AddForm
          isOpen
          newLabel={t("apiKeyNew")}
          submitLabel={t("apiKeyCreate")}
          canSubmit={!busy && name.trim() !== ""}
          onOpen={() => setAdding(true)}
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
          <LevelChoice className="key-level" value={level} onChange={setLevel} />
          <ReplyModeChoice className="key-level" value={replyMode} onChange={setReplyMode} />
        </AddForm>
      )}
      <ErrorNote text={failure ?? keys.failure} />
      {revoking !== null && (
        <Confirm
          title={t(app ? "appDisconnectTitle" : "apiKeyRevokeTitle", { name: revoking.name })}
          text={t(app ? "appDisconnectText" : "apiKeyRevokeText")}
          confirm={t(app ? "appDisconnect" : "apiKeyRevoke")}
          disabled={busy}
          onConfirm={() => void revoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      )}
    </Section>
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
    when(row.replayedAt ?? row.createdAt),
    plural(row.attempts, "deliveryAttemptOne", "deliveryAttempts"),
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
      {/* A pending delivery still goes, so a replay would send it twice. */}
      {row.status !== "pending" && (
        <button
          type="button"
          className="pill small delivery-replay"
          aria-label={t("deliveryReplayLabel", {
            type: row.type,
            date: when(row.replayedAt ?? row.createdAt),
          })}
          onClick={onReplay}
        >
          {t("deliveryReplay")}
        </button>
      )}
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
  if (rows === null) return <ListSkeleton />;
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

/** A webhook's events, which Save changes, and its actions: test, deliveries, new secret, delete. */
function WebhookEdit({
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
  const [events, setEvents] = useState<WebhookEvent[]>(hook.events);
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
  const isChanged = events.join() !== hook.events.join();
  return (
    <div className="hook-edit">
      <EventPicker events={events} onChange={setEvents} />
      <div className="hook-actions">
        <button
          type="button"
          className="pill dark small"
          disabled={!isChanged || events.length === 0}
          onClick={() =>
            void run(async () => {
              onChanged(await api.changeWebhook(hook.id, { events }));
              toast("saved");
            })
          }
        >
          {t("save")}
        </button>
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
    </div>
  );
}

/** A webhook's row: its address, events and who added it, its switch, and Edit. */
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
  const [isEditing, setIsEditing] = useState(false);
  const [failure, setFailure] = useState<TextId | null>(null);
  return (
    <li className="item-row hook">
      <span className="item-ic">
        <Icon name="webhook" size={20} />
      </span>
      <div className="item-text">
        <strong className="item-name" title={hook.url}>
          {bare(hook.url)}
        </strong>
        <span className="item-line">
          <EventsSummary events={hook.events} />
          {hook.createdBy !== null && (
            <>
              <span className="sep" aria-hidden="true">
                ·
              </span>
              <span>
                {t(hook.createdBy.kind === "key" ? "webhookByKey" : "webhookByOperator", {
                  name: hook.createdBy.name,
                })}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="item-tools">
        <label className="check hook-switch">
          <span className="visually-hidden">{t("webhookEnabledLabel", { url: hook.url })}</span>
          <input
            type="checkbox"
            checked={hook.enabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              setFailure(null);
              api
                .changeWebhook(hook.id, { enabled })
                .then(onChanged, (error: unknown) => setFailure(failureText(error, {})));
            }}
          />
        </label>
        <button
          type="button"
          className="pill small"
          aria-expanded={isEditing}
          aria-label={t("webhookEditLabel", { url: hook.url })}
          onClick={() => setIsEditing((current) => !current)}
        >
          {t("webhookEdit")}
        </button>
      </div>
      <ErrorNote text={failure} />
      {isEditing && <WebhookEdit api={api} hook={hook} onChanged={onChanged} onAsk={onAsk} />}
    </li>
  );
}

/** Owners and admins send the workspace's events to their own servers. */
function WebhooksSection({ api }: { api: WorkspaceApi }) {
  const loaded = useLoad(() => api.webhooks(), [api]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const {
    busy,
    failure,
    setFailure,
    run: act,
  } = useAction(loaded.reload, {
    400: "webhookBadUrl",
    409: "webhookLimit",
  });
  const [asking, setAsking] = useState<Asking>(null);
  // The new webhook's form shows only once the owner asks for it.
  const [adding, setAdding] = useState(false);
  const hooks = loaded.data?.webhooks ?? [];

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

  const isFull = hooks.length >= MAX_WEBHOOKS;
  const newHook = (
    <button
      type="button"
      className="pill"
      onClick={() => {
        setSecret(null);
        setAdding(true);
      }}
    >
      <Icon name="plusBold" size={14} />
      {t("webhookNew")}
    </button>
  );
  return (
    <Section
      title={t("webhooksTitle")}
      help={t("webhooksHelp")}
      action={isFull || adding ? undefined : newHook}
    >
      {hooks.length === 0 && loaded.data !== null ? (
        <p className="sec-empty">{t("webhooksNone")}</p>
      ) : (
        <ul className="items">
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
      {isFull && <StatusNote text="webhookLimit" />}
      {adding && !isFull && (
        <AddForm
          isOpen
          newLabel={t("webhookNew")}
          submitLabel={t("webhookAdd")}
          canSubmit={!busy && url.trim() !== "" && events.length > 0}
          onOpen={() => setAdding(true)}
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
          <p className="hint">{t("webhookVerifyNote")}</p>
        </AddForm>
      )}
      <ErrorNote text={failure ?? loaded.failure} />
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
    </Section>
  );
}

/** "1 connected app, 2 API keys", with each count in its own words. */
function countLine(keys: ApiKey[]): string {
  const apps = keys.filter((key) => key.source === "oauth").length;
  const made = keys.length - apps;
  return t("botsCount", {
    apps: plural(apps, "botsCountAppOne", "botsCountApps"),
    keys: plural(made, "botsCountKeyOne", "botsCountKeys"),
  });
}

/**
 * How many bots can answer, whether they are paused and by whom, and one switch that stops every
 * key and connected app from replying, for owners and admins.
 */
function BotsStatus({
  keys,
  paused,
  pausedBy,
  onChange,
}: {
  keys: ApiKey[] | null;
  paused: boolean;
  pausedBy: string | null;
  onChange: ((paused: boolean) => void) | null;
}) {
  return (
    <section className={paused ? "status-card paused" : "status-card"} aria-label={t("botsTitle")}>
      <span className="status-art">
        <Icon name="robot" size={30} />
        {paused && (
          <span className="status-badge">
            <Icon name="pause" size={12} />
          </span>
        )}
      </span>
      <div>
        <h3>
          {keys === null ? t("botsTitle") : countLine(keys)}
          {paused && (
            <span className="state-tag">
              <span className="state-dot" />
              {t("botsPausedTag")}
            </span>
          )}
        </h3>
        <p>
          {t(paused ? "botsPausedHelp" : "botsRunningHelp")}
          {paused && pausedBy !== null && (
            <>
              {" "}
              <b>{t("botsPausedBy", { name: pausedBy })}.</b>
            </>
          )}
        </p>
      </div>
      <label className="check big-switch">
        <input
          type="checkbox"
          checked={paused}
          disabled={onChange === null}
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <small>{t("botsPauseToggle")}</small>
      </label>
    </section>
  );
}

/** API & webhooks: what lets other software read and answer chats, or hear about them. */
export function DevelopersPage({
  api,
  botsPaused,
  botsPausedBy,
  onBotsPaused,
}: {
  api: WorkspaceApi;
  botsPaused: boolean;
  /** Who paused the bots, or null. */
  botsPausedBy: string | null;
  /** Pauses or resumes every bot. Null for a member. */
  onBotsPaused: ((paused: boolean) => void) | null;
}) {
  const keys = useLoad(() => api.apiKeys(), [api]);
  return (
    <Page title={t("pageDevelopers")} context={t("developersContext")}>
      <BotsStatus
        keys={keys.data?.apiKeys ?? null}
        paused={botsPaused}
        pausedBy={botsPausedBy}
        onChange={onBotsPaused}
      />
      <KeysSection api={api} keys={keys} source="oauth" />
      <KeysSection api={api} keys={keys} source="static" />
      <WebhooksSection api={api} />
    </Page>
  );
}
