/** @jsxImportSource react */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type CodeLanguage, highlight } from "../../../packages/widget/src/highlight.ts";
import type { WorkspaceApi, WorkspaceSettings } from "./api.ts";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import {
  CopyButton,
  DocLink,
  ErrorNote,
  failureText,
  Icon,
  type Note,
  Page,
  PageRow,
  SaveNote,
  StatusNote,
} from "./ui.tsx";

/** The code's lines as text and colored spans. Each span's key is where it starts in the code. */
function codeNodes(value: string, language: CodeLanguage): ReactNode[] {
  const nodes: ReactNode[] = [];
  let at = 0;
  highlight(value, language).forEach((line, index) => {
    if (index > 0) {
      nodes.push("\n");
      at += 1;
    }
    for (const { kind, text } of line.tokens) {
      nodes.push(
        kind === null ? (
          text
        ) : (
          <span key={at} className={`code-${kind}`}>
            {text}
          </span>
        ),
      );
      at += text.length;
    }
  });
  return nodes;
}

/** Code to paste, colored as in the docs. Copy copies the exact text. */
function CodeBlock({
  value,
  language,
  title,
}: {
  value: string;
  language: CodeLanguage;
  title: string;
}) {
  return (
    <div className="code-block">
      <div className="code-bar">
        <span>{title}</span>
        <CopyButton value={value} />
      </div>
      <pre>
        <code>{codeNodes(value, language)}</code>
      </pre>
    </div>
  );
}

function SnippetRow({ publicKey, waiting }: { publicKey: string; waiting: boolean }) {
  // A workspace that waits for the cloud serves no widget, so its code would not work yet.
  if (waiting) {
    return (
      <PageRow title={t("snippetTitle")}>
        <p className="quiet">{t("snippetWaiting")}</p>
      </PageRow>
    );
  }
  // One line, as a developer pastes it. It scrolls sideways in its box instead of breaking.
  const snippet = `<script src="${location.origin}/widget/loader.js" data-key="${publicKey}" async></script>`;
  return (
    <PageRow title={t("snippetTitle")} help={t("snippetHelp")}>
      <CodeBlock value={snippet} language="html" title={t("codeHtml")} />
      <p className="hint">{t("snippetOverride")}</p>
      <DocLink path="add-to-your-site#change-how-it-looks" text="appearanceDocsLink" />
    </PageRow>
  );
}

/** The browser's copy of the server's check, so a mistake shows under its own row before saving. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

interface SiteRow {
  key: number;
  value: string;
}

function OriginsRow({
  api,
  settings,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  onSaved(saved: WorkspaceSettings): void;
}) {
  const next = useRef(0);
  const toRows = (origins: string[]): SiteRow[] =>
    (origins.length === 0 ? [""] : origins).map((value) => ({ key: next.current++, value }));
  const [rows, setRows] = useState(() => toRows(settings.allowedOrigins));
  // Rows are checked once the operator tries to save, and then on every change.
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  useEffect(() => {
    if (focusKey === null) return;
    inputs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const wrong = (row: SiteRow) => row.value.trim() !== "" && !isOrigin(row.value.trim());
  const change = (update: (current: SiteRow[]) => SiteRow[]) => {
    setRows(update);
    setNote(null);
  };
  const add = () => {
    const key = next.current++;
    change((current) => [...current, { key, value: "" }]);
    setFocusKey(key);
  };
  const remove = (index: number) => {
    const after = rows.filter((_, at) => at !== index);
    const keep = after.length === 0 ? [{ key: next.current++, value: "" }] : after;
    change(() => keep);
    // The focus moves to the row that took this one's place.
    setFocusKey(keep[Math.min(index, keep.length - 1)]?.key ?? null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    const firstWrong = rows.find(wrong);
    if (firstWrong !== undefined) {
      inputs.current.get(firstWrong.key)?.focus();
      return;
    }
    const list = rows.map((row) => row.value.trim()).filter((value) => value !== "");
    try {
      const saved = await api.setOrigins(list);
      onSaved(saved);
      setRows(toRows(saved.allowedOrigins));
      setChecked(false);
      setNote({ ok: true, text: "originsSaved" });
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, { 400: "originsBad" }) });
    }
  };

  return (
    <PageRow title={t("originsTitle")} help={t("originsHelp")}>
      <form className="stack" onSubmit={save} noValidate>
        <ul className="sites">
          {rows.map((row, index) => {
            const shown = checked && wrong(row);
            const errorId = `site-error-${row.key}`;
            const name = t("originsSite", { number: String(index + 1) });
            return (
              <li key={row.key}>
                <div className="site">
                  <input
                    ref={(element) => {
                      if (element === null) inputs.current.delete(row.key);
                      else inputs.current.set(row.key, element);
                    }}
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="https://example.com"
                    aria-label={name}
                    aria-invalid={shown}
                    aria-describedby={shown ? errorId : undefined}
                    value={row.value}
                    onChange={(event) => {
                      const value = event.target.value;
                      change((current) =>
                        current.map((one) => (one.key === row.key ? { ...one, value } : one)),
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("originsRemove", { site: row.value.trim() || name })}
                    onClick={() => remove(index)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                {shown && (
                  <p id={errorId} className="field-error">
                    {t("originsBadRow")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="actions spread">
          <button type="button" className="text-button" onClick={add}>
            <Icon name="plusBold" size={14} />
            {t("originsAdd")}
          </button>
          <button type="submit" className="pill dark">
            {t("save")}
          </button>
        </div>
        <SaveNote note={note} />
      </form>
    </PageRow>
  );
}

function SecretRow({
  api,
  settings,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  onSaved(saved: WorkspaceSettings): void;
}) {
  const [shown, setShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextId | null>(null);
  const [replaced, setReplaced] = useState(false);
  const rotate = async () => {
    setError(null);
    setBusy(true);
    try {
      onSaved(await api.rotateSecret());
      setShown(true);
      setReplaced(true);
      setConfirming(false);
    } catch (failure) {
      setError(failureText(failure, {}));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageRow title={t("secretTitle")} help={t("secretHelp")}>
      <div className="copy-field">
        <input
          className="mono"
          readOnly
          aria-label={t("identitySecretLabel")}
          type={shown ? "text" : "password"}
          value={settings.signingSecret}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="icon-button"
          aria-label={shown ? t("secretHide") : t("secretShow")}
          title={shown ? t("secretHide") : t("secretShow")}
          onClick={() => setShown((current) => !current)}
        >
          <Icon name={shown ? "eyeOff" : "eye"} size={18} />
        </button>
        <CopyButton value={settings.signingSecret} label={t("secretCopy")} />
      </div>
      {replaced && <StatusNote text="secretReplaced" />}
      <button
        type="button"
        className="pill danger-soft"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        {t("secretRotate")}
      </button>
      <DocLink path="add-to-your-site#show-who-is-chatting" text="secretDocsLink" />
      {confirming && (
        <Confirm
          title={t("secretConfirmTitle")}
          text={t("secretWarning")}
          confirm={t("secretConfirm")}
          disabled={busy}
          onConfirm={() => void rotate()}
          onCancel={() => setConfirming(false)}
        >
          <ErrorNote text={error} />
        </Confirm>
      )}
    </PageRow>
  );
}

/** Install: the code, the sites that may show the chat, and the optional identity secret. */
export function InstallPage({
  api,
  settings,
  waiting,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  /** The workspace waits for the cloud to open, so its widget is off. */
  waiting: boolean;
  onSaved(saved: WorkspaceSettings): void;
}) {
  return (
    <Page
      title={t("tabInstall")}
      context={
        <>
          {t("installContext")}{" "}
          <DocLink path="add-to-your-site#add-the-tag" text="installDocsLink" />
        </>
      }
    >
      <SnippetRow publicKey={settings.publicKey} waiting={waiting} />
      <OriginsRow api={api} settings={settings} onSaved={onSaved} />
      <SecretRow api={api} settings={settings} onSaved={onSaved} />
    </Page>
  );
}
