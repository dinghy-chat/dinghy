/** @jsxImportSource react */
import { useState } from "react";
import {
  ApiError,
  type Me,
  removePicture,
  requestAccountDelete,
  setPicture,
  updateName,
} from "./api.ts";
import { Icon } from "./icons.tsx";
import { Confirm } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { savedTheme, setTheme, type Theme } from "./theme.ts";
import {
  Choices,
  ErrorNote,
  failureText,
  ImageUpload,
  NameField,
  type Option,
  Page,
  PageRow,
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

const THEMES: Option<Theme>[] = [
  { value: "system", label: "themeSystem", icon: "monitor" },
  { value: "light", label: "themeLight", icon: "sun" },
  { value: "dark", label: "themeDark", icon: "moon" },
];

/** Light, dark, or the device's own setting. It applies at once, on this device only. */
function ThemeChoice() {
  const [theme, setThemeState] = useState(savedTheme);
  return (
    <Choices
      label={t("theme")}
      value={theme}
      options={THEMES}
      onChange={(next) => {
        setTheme(next);
        setThemeState(next);
      }}
    />
  );
}

/**
 * The operator deletes their account. The dialog says what happens to each workspace they alone
 * own: it passes to a teammate, or goes with the account when nobody else is in it. The Profile
 * page shows it, and so does every screen an operator can land on without a workspace.
 */
export function DeleteAccount({
  me,
  emailAvailable,
  onDeleted,
}: {
  me: Me;
  /** The server sends email, so a link confirms. Without, the operator types their email. */
  emailAvailable: boolean;
  onDeleted(): void;
}) {
  const owned = me.workspaces.filter((one) => one.soleOwner);
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
      // The workspace's own delete has the same code, with words about the workspace.
      const last = failure instanceof ApiError && failure.code === "last_workspace";
      setError(
        last
          ? "deleteAccountLastWorkspace"
          : failureText(failure, { 400: "deleteAccountFailed" }, "deleteAccountFailed"),
      );
    }
    setBusy(false);
  };
  const matches = typed.trim().toLowerCase() === me.email.toLowerCase();
  return (
    <>
      <button
        type="button"
        className="pill danger-soft"
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
          {owned.length > 0 && (
            <ul className="delete-outcomes">
              {owned.map((one) => (
                <li key={one.workspaceId} className="outcome">
                  <Icon name={one.heir === null ? "trash" : "user"} size={16} />
                  {one.heir === null
                    ? t("deleteAccountWorkspaceGoes", { name: one.name })
                    : t("deleteAccountWorkspacePasses", { name: one.name, heir: one.heir })}
                </li>
              ))}
            </ul>
          )}
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
  onChanged,
  onAccountDeleted,
}: {
  me: Me;
  emailAvailable: boolean;
  onChanged(): void;
  onAccountDeleted(): void;
}) {
  return (
    <Page title={t("pageProfile")} context={t("profileContext")}>
      <PageRow title={t("accountName")} help={t("accountHelp")}>
        <NameField
          label={t("accountName")}
          name={me.name}
          autoComplete="name"
          onSave={async (name) => {
            await updateName(name);
            onChanged();
          }}
        />
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
      <PageRow
        title={t("deleteAccountTitle")}
        help={t("deleteAccountHelp")}
        docs={[{ path: "operator-guide#delete-your-account", text: "accountDocsLink" }]}
        danger
      >
        <DeleteAccount me={me} emailAvailable={emailAvailable} onDeleted={onAccountDeleted} />
      </PageRow>
    </Page>
  );
}
