/** @jsxImportSource react */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type ApiKey,
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookTest,
  type WorkspaceApi,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import {
  CopyButton,
  DocLink,
  ErrorNote,
  Field,
  failureText,
  Page,
  PageRow,
  StatusNote,
} from "./ui.tsx";

const MAX_WEBHOOKS = 5;

const EVENT_TEXT: Record<WebhookEvent, TextId> = {
  "conversation.created": "webhookEventCreated",
  "message.created": "webhookEventMessage",
  "conversation.closed": "webhookEventClosed",
  "conversation.reopened": "webhookEventReopened",
  "conversation.assigned": "webhookEventAssigned",
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

/** A secret or token that the server shows once, with a way to copy it. */
function ShownOnce({ label, value }: { label: string; value: string }) {
  return (
    <div className="created" role="status">
      <p className="hint">{t("shownOnce")}</p>
      <div className="copy-field">
        <input
          className="mono"
          readOnly
          aria-label={label}
          value={value}
          spellCheck={false}
          autoComplete="off"
        />
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

/** One line of the key list: who made it and when it was last used. */
function apiKeyLine(key: ApiKey): string {
  const made =
    key.createdByName === null
      ? t("apiKeyMade", { date: when(key.createdAt) })
      : t("apiKeyMadeBy", { name: key.createdByName, date: when(key.createdAt) });
  const used =
    key.lastUsedAt === null
      ? t("apiKeyNeverUsed")
      : t("apiKeyUsed", { date: when(key.lastUsedAt) });
  return `${made} ${used}`;
}

/** Owners and admins make keys for scripts and AI agents, and revoke them. */
function ApiKeysRow({ api }: { api: WorkspaceApi }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // The new key's form shows only once the owner asks for it.
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.apiKeys().then(
      (answer) => setKeys(answer.apiKeys),
      (error: unknown) => setFailure(failureText(error, {}, "actionFailed")),
    );
  }, [api]);
  useEffect(load, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setBusy(true);
    try {
      const { token, ...key } = await api.createApiKey(name.trim());
      setMade({ name: key.name, token });
      setName("");
      setAdding(false);
      load();
    } catch (error) {
      setFailure(failureText(error, {}));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    setBusy(true);
    try {
      await api.revokeApiKey(key.id);
      setRevoking(null);
      load();
    } catch (error) {
      setFailure(failureText(error, {}));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageRow title={t("apiKeysTitle")} help={t("apiKeysHelp")}>
      {keys.length > 0 && (
        <ul className="item-list">
          {keys.map((key) => (
            <li key={key.id}>
              <span className="who-lines">
                <strong>{key.name}</strong>
                <span>{apiKeyLine(key)}</span>
              </span>
              <button
                type="button"
                className="pill small danger-soft"
                aria-label={t("apiKeyRevokeLabel", { name: key.name })}
                onClick={() => setRevoking(key)}
              >
                {t("apiKeyRevoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {made !== null && (
        <ShownOnce label={t("apiKeyCopy", { name: made.name })} value={made.token} />
      )}
      {adding ? (
        <form className="stack" onSubmit={create}>
          <Field
            label={t("apiKeyName")}
            hint={t("apiKeyNameHint")}
            placeholder={t("apiKeyNamePlaceholder")}
            maxLength={60}
            required
            autoComplete="off"
            value={name}
            onChange={setName}
          />
          <div className="actions">
            <button type="submit" className="pill dark" disabled={busy || name.trim() === ""}>
              {t("apiKeyCreate")}
            </button>
            <button
              type="button"
              className="pill"
              onClick={() => {
                setAdding(false);
                setName("");
                setFailure(null);
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
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
        </div>
      )}
      <ErrorNote text={failure} />
      <div className="doc-links">
        <DocLink path="api#api-keys" text="apiDocsLink" />
        <DocLink path="api#mcp" text="mcpDocsLink" />
      </div>
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
  if (result.delivered)
    return { ok: true, text: t("webhookTestOk", { status: result.status ?? "" }) };
  if (result.status !== null) {
    return { ok: false, text: t("webhookTestStatus", { status: result.status }) };
  }
  return { ok: false, text: t("webhookTestError", { error: result.error ?? "" }) };
}

function Deliveries({ api, webhookId }: { api: WorkspaceApi; webhookId: string }) {
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  useEffect(() => {
    api.webhookDeliveries(webhookId).then(
      (answer) => setRows(answer.deliveries),
      (error: unknown) => setFailure(failureText(error, {}, "actionFailed")),
    );
  }, [api, webhookId]);
  if (failure !== null) return <ErrorNote text={failure} />;
  if (rows === null) return <p className="quiet">{t("loading")}</p>;
  if (rows.length === 0) return <p className="quiet">{t("deliveriesNone")}</p>;
  return (
    <ul className="deliveries" aria-label={t("deliveriesTitle")}>
      {rows.map((row) => (
        <li key={row.id} className="delivery">
          <span className={`chip${row.status === "failed" ? " warn" : ""}`}>
            {t(DELIVERY_TEXT[row.status])}
          </span>
          <code>{row.type}</code>
          <span className="quiet">
            {[
              when(row.createdAt),
              t(row.attempts === 1 ? "deliveryAttemptOne" : "deliveryAttempts", {
                count: row.attempts,
              }),
              row.lastStatus === null ? null : `HTTP ${row.lastStatus}`,
              row.lastError,
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
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
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  // The new webhook's form shows only once the owner asks for it.
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api.webhooks().then(
      (answer) => setHooks(answer.webhooks),
      (error: unknown) => setFailure(failureText(error, {}, "actionFailed")),
    );
  }, [api]);
  useEffect(load, [load]);

  const act = async (work: () => Promise<void>) => {
    setFailure(null);
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setFailure(failureText(error, { 400: "webhookBadUrl", 409: "webhookLimit" }));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const made = await api.createWebhook(url.trim(), events);
      setSecret({ url: made.url, secret: made.secret });
      setUrl("");
      setEvents([...WEBHOOK_EVENTS]);
      setAdding(false);
      load();
    });
  };

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
      load();
    });

  const full = hooks.length >= MAX_WEBHOOKS;
  const cancel = () => {
    setAdding(false);
    setUrl("");
    setEvents([...WEBHOOK_EVENTS]);
    setFailure(null);
  };
  return (
    <PageRow title={t("webhooksTitle")} help={t("webhooksHelp")}>
      {hooks.length > 0 && (
        <ul className="item-list">
          {hooks.map((hook) => (
            <WebhookItem
              key={hook.id}
              api={api}
              hook={hook}
              onAsk={setAsking}
              onChanged={(changed) =>
                setHooks((current) => current.map((one) => (one.id === changed.id ? changed : one)))
              }
            />
          ))}
        </ul>
      )}
      {secret !== null && (
        <ShownOnce label={t("webhookSecretCopy", { url: secret.url })} value={secret.secret} />
      )}
      {full ? (
        <StatusNote text="webhookLimit" />
      ) : !adding ? (
        <div className="actions">
          <button
            type="button"
            className="pill dark"
            onClick={() => {
              setSecret(null);
              setAdding(true);
            }}
          >
            <Icon name="plusBold" size={14} />
            {t("webhookNew")}
          </button>
        </div>
      ) : (
        <form className="stack hook-form" onSubmit={add}>
          <Field
            label={t("webhookUrl")}
            hint={t("webhookUrlHint")}
            type="url"
            inputMode="url"
            placeholder="https://example.com/dinghy"
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={2000}
            value={url}
            onChange={setUrl}
          />
          <EventPicker events={events} onChange={setEvents} />
          <div className="actions">
            <button
              type="submit"
              className="pill dark"
              disabled={busy || url.trim() === "" || events.length === 0}
            >
              {t("webhookAdd")}
            </button>
            <button type="button" className="pill" onClick={cancel}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      <ErrorNote text={failure} />
      <p className="hint">{t("webhookVerifyNote")}</p>
      <DocLink path="api#webhooks" text="webhookDocsLink" />
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

/** API & webhooks: what lets other software read and answer chats, or hear about them. */
export function DevelopersPage({ api }: { api: WorkspaceApi }) {
  return (
    <Page title={t("pageDevelopers")}>
      <ApiKeysRow api={api} />
      <WebhooksRow api={api} />
    </Page>
  );
}
