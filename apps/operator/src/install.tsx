/** @jsxImportSource react */
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type CodeLanguage, highlight } from "../../../packages/widget/src/highlight.ts";
import type { WorkspaceApi, WorkspaceSettings } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { CopyButton, ErrorNote, failureText, Page, PageRow } from "./ui.tsx";

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
    <PageRow
      title={t("snippetTitle")}
      help={t("snippetHelp")}
      docs={[
        { path: "add-to-your-site#add-the-tag", text: "installDocsLink" },
        { path: "add-to-your-site#change-how-it-looks", text: "appearanceDocsLink" },
      ]}
    >
      <CodeBlock value={snippet} language="html" title={t("codeHtml")} />
      <p className="hint">{t("snippetOverride")}</p>
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

/**
 * The sites that may show the chat, as cards. Each add or remove saves at once. The field to add
 * one shows only after "Add a site".
 */
function OriginsRow({
  api,
  settings,
  onSaved,
}: {
  api: WorkspaceApi;
  settings: WorkspaceSettings;
  onSaved(saved: WorkspaceSettings): void;
}) {
  const sites = settings.allowedOrigins;
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // The operator asked for the field, so it takes the focus.
  useEffect(() => {
    if (adding) field.current?.focus();
  }, [adding]);

  const save = async (list: string[], done: TextId) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setOrigins(list));
      toast(done);
      return true;
    } catch (failure) {
      setError(failureText(failure, { 400: "originsBad" }));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    const site = typed.trim();
    if (!isOrigin(site)) {
      setError("originsBadRow");
      return;
    }
    if (await save([...sites, site], "originsAdded")) {
      setTyped("");
      setAdding(false);
    }
  };
  const close = () => {
    setTyped("");
    setError(null);
    setAdding(false);
  };

  return (
    <PageRow title={t("originsTitle")} help={t("originsHelp")}>
      {sites.length === 0 && !adding && <p className="quiet">{t("originsNone")}</p>}
      {sites.length > 0 && (
        <ul className="sites">
          {sites.map((site) => (
            <li key={site} className="site-card">
              <span>{site}</span>
              <button
                type="button"
                className="icon-button quiet-danger"
                aria-label={t("originsRemove", { site })}
                title={t("originsRemove", { site })}
                disabled={busy}
                onClick={() =>
                  void save(
                    sites.filter((one) => one !== site),
                    "originsRemoved",
                  )
                }
              >
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form className="site-add" onSubmit={add} noValidate>
          <input
            ref={field}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com"
            aria-label={t("originsNew")}
            aria-invalid={error === "originsBadRow"}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
            }}
          />
          <div className="actions">
            <button type="submit" className="pill dark" disabled={busy || typed.trim() === ""}>
              {t("originsAddButton")}
            </button>
            <button type="button" className="pill" onClick={close}>
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="text-button" onClick={() => setAdding(true)}>
          <Icon name="plusBold" size={14} />
          {t("originsAdd")}
        </button>
      )}
      <ErrorNote text={error} />
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
  const rotate = async () => {
    setError(null);
    setBusy(true);
    try {
      onSaved(await api.rotateSecret());
      setShown(true);
      toast("secretReplaced");
      setConfirming(false);
    } catch (failure) {
      setError(failureText(failure, {}));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageRow
      title={t("secretTitle")}
      help={t("secretHelp")}
      docs={[{ path: "add-to-your-site#show-who-is-chatting", text: "secretDocsLink" }]}
    >
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
    <Page title={t("pageInstall")} context={t("installContext")}>
      <SnippetRow publicKey={settings.publicKey} waiting={waiting} />
      <OriginsRow api={api} settings={settings} onSaved={onSaved} />
      <SecretRow api={api} settings={settings} onSaved={onSaved} />
    </Page>
  );
}
