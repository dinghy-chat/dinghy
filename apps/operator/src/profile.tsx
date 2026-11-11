/** @jsxImportSource react */
import { type FormEvent, useId, useState } from "react";
import { type Me, removePicture, requestAccountDelete, setPicture, updateName } from "./api.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Confirm } from "./popup.tsx";
import type { OwnerStep } from "./settings.tsx";
import { type TextId, t } from "./text.ts";
import { savedTheme, setTheme, type Theme } from "./theme.ts";
import {
  DocLink,
  ErrorNote,
  failureText,
  ImageUpload,
  type Note,
  Page,
  PageRow,
  SaveNote,
  TypeToConfirm,
  type UploadText,
} from "./ui.tsx";

const PICTURE_TEXT: UploadText = {
  upload: "pictureUpload",
  replace: "pictureReplace",
  remove: "pictureRemove",
  preview: "picturePreview",
  tooLarge: "pictureTooLarge",
};

const THEMES: { value: Theme; label: TextId; icon: IconName }[] = [
  { value: "system", label: "themeSystem", icon: "monitor" },
  { value: "light", label: "themeLight", icon: "sun" },
  { value: "dark", label: "themeDark", icon: "moon" },
];

/** Light, dark, or the device's own setting. It applies at once, on this device only. */
function ThemeChoice() {
  const [theme, setThemeState] = useState(savedTheme);
  return (
    <fieldset className="choices" aria-label={t("theme")}>
      {THEMES.map((choice) => (
        <label key={choice.value}>
          <input
            type="radio"
            name="theme"
            checked={theme === choice.value}
            onChange={() => {
              setTheme(choice.value);
              setThemeState(choice.value);
            }}
          />
          <Icon name={choice.icon} size={16} />
          {t(choice.label)}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The operator deletes their account, once no workspace would be left without an owner. The
 * Profile page shows it, and so does every screen an operator can land on without a workspace.
 */
export function DeleteAccount({
  me,
  emailAvailable,
  keepsLastWorkspace,
  onOpen,
  onDeleted,
}: {
  me: Me;
  /** The server sends email, so a link confirms. Without, the operator types their email. */
  emailAvailable: boolean;
  /** A self-hosted server, which keeps its last workspace. */
  keepsLastWorkspace: boolean;
  onOpen(workspaceId: string, step: OwnerStep): void;
  onDeleted(): void;
}) {
  const blockers = me.workspaces.filter((one) => one.soleOwner);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const { deleted } = await requestAccountDelete(emailAvailable ? undefined : typed.trim());
      if (deleted) {
        onDeleted();
        return;
      }
      setSent(true);
    } catch (failure) {
      setError(failureText(failure, { 400: "deleteAccountFailed" }, "deleteAccountFailed"));
    }
    setBusy(false);
  };
  const matches = typed.trim().toLowerCase() === me.email.toLowerCase();
  const blockedId = useId();
  const isBlocked = blockers.length > 0;
  return (
    <>
      {isBlocked && (
        <div className="blockers">
          <p className="blockers-warning" id={blockedId}>
            <Icon name="warning" size={18} />
            {t("deleteAccountBlocked")}
          </p>
          <ul className="blocker-list">
            {blockers.map((one) => (
              <li key={one.workspaceId}>
                <span className="blocker-name">
                  <b>{one.name}</b>
                  <span className="chip">{t("deleteAccountOnlyOwner")}</span>
                </span>
                <span className="actions">
                  {/* A workspace that waits for payment has no Team page until it is paid. */}
                  {(one.active || one.waiting) && (
                    <button
                      type="button"
                      className="pill small"
                      onClick={() => onOpen(one.workspaceId, "team")}
                    >
                      {t("deleteAccountMakeOwner")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="pill small danger-soft"
                    onClick={() => onOpen(one.workspaceId, "delete")}
                  >
                    {t("deleteAccountWorkspace")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {keepsLastWorkspace && <p className="hint">{t("deleteAccountOnlyServer")}</p>}
        </div>
      )}
      <button
        type="button"
        className="pill danger-soft"
        disabled={isBlocked}
        aria-describedby={isBlocked ? blockedId : undefined}
        onClick={() => {
          setTyped("");
          setSent(false);
          setError(null);
          setOpen(true);
        }}
      >
        {t("deleteAccountOpen")}
      </button>
      {open && (
        <Confirm
          title={t("deleteAccountConfirmTitle")}
          text={t(emailAvailable ? "deleteAccountConfirmEmail" : "deleteAccountConfirmTyped")}
          confirm={t(emailAvailable ? "deleteAccountSend" : "deleteAccountButton")}
          disabled={busy || sent || (!emailAvailable && !matches)}
          onConfirm={() => void submit()}
          onCancel={() => setOpen(false)}
        >
          {!emailAvailable && (
            <TypeToConfirm
              text="deleteAccountType"
              value={me.email}
              typed={typed}
              onChange={setTyped}
              type="email"
            />
          )}
          {sent && (
            <p className="note" role="status">
              {t("deleteAccountSent", { email: me.email })}
            </p>
          )}
          <ErrorNote text={error} />
        </Confirm>
      )}
    </>
  );
}

export function ProfilePage({
  me,
  emailAvailable,
  keepsLastWorkspace,
  onChanged,
  onOpenWorkspace,
  onAccountDeleted,
}: {
  me: Me;
  emailAvailable: boolean;
  keepsLastWorkspace: boolean;
  onChanged(): void;
  onOpenWorkspace(workspaceId: string, step: OwnerStep): void;
  onAccountDeleted(): void;
}) {
  const [name, setName] = useState(me.name);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await updateName(name.trim());
      setName(name.trim());
      setNote({ ok: true, text: "accountNameSaved" });
      onChanged();
    } catch (failure) {
      setNote({ ok: false, text: failureText(failure, {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={t("pageProfile")} context={t("profileContext")}>
      <form className="profile" onSubmit={save}>
        <PageRow title={t("accountName")} help={t("accountHelp")}>
          <div className="inline-field">
            <input
              aria-label={t("accountName")}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNote(null);
              }}
              required
              maxLength={100}
              autoComplete="name"
            />
            <button
              type="submit"
              className="pill dark"
              disabled={busy || name.trim() === "" || name.trim() === me.name}
            >
              {t("accountNameSave")}
            </button>
          </div>
          <SaveNote note={note} />
        </PageRow>
        <PageRow title={t("email")} help={t("accountEmailHelp")}>
          <input aria-label={t("email")} value={me.email} readOnly />
        </PageRow>
        <PageRow title={t("pictureTitle")} help={t("pictureHelp")}>
          <ImageUpload
            url={me.pictureUrl}
            text={PICTURE_TEXT}
            onUpload={async (file) => {
              await setPicture(file);
              onChanged();
            }}
            onRemove={async () => {
              await removePicture();
              onChanged();
            }}
          />
        </PageRow>
        <PageRow title={t("theme")} help={t("themeHelp")}>
          <ThemeChoice />
        </PageRow>
      </form>
      {/* Outside the form, because its dialog has a form of its own. */}
      <PageRow title={t("deleteAccountTitle")} help={t("deleteAccountHelp")} danger>
        <DeleteAccount
          me={me}
          emailAvailable={emailAvailable}
          keepsLastWorkspace={keepsLastWorkspace}
          onOpen={onOpenWorkspace}
          onDeleted={onAccountDeleted}
        />
        <DocLink path="operator-guide#your-profile" text="accountDocsLink" />
      </PageRow>
    </Page>
  );
}
