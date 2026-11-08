/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import { askSignInLink } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { AuthPage, ErrorNote, Field, failureText } from "./ui.tsx";

/** Why a link brought the browser back here, from the `error` that the server added. */
const LINK_ERRORS: Record<string, TextId> = {
  invite_invalid: "inviteInvalid",
  operator_limit: "operatorLimit",
  email_taken: "emailTaken",
};

/** Reads a link's error once, and takes it out of the address so a reload does not show it again. */
function takeLinkError(): TextId | null {
  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  if (error === null) return null;
  params.delete("error");
  params.delete("error_description");
  const rest = params.toString();
  history.replaceState(null, "", `${location.pathname}${rest === "" ? "" : `?${rest}`}`);
  return LINK_ERRORS[error] ?? "linkInvalid";
}

export function SignIn({
  emailAvailable,
  signup = false,
}: {
  emailAvailable: boolean;
  signup?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<TextId | null>(takeLinkError);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await askSignInLink(email.trim());
      setSentTo(email.trim());
    } catch (failure) {
      setError(failureText(failure, { 429: "tooManyAttempts" }));
    } finally {
      setBusy(false);
    }
  };

  if (sentTo !== null) {
    return (
      <CheckEmail
        text={t("checkEmailSignIn").replace("{email}", sentTo)}
        onBack={() => setSentTo(null)}
      />
    );
  }
  if (!emailAvailable) {
    return (
      <AuthPage>
        <h1>{t("signInTitle")}</h1>
        <ErrorNote text={error} />
        <p className="note">{t("signInNoMail")}</p>
      </AuthPage>
    );
  }
  return (
    <AuthPage onSubmit={submit}>
      <h1>{t("signInTitle")}</h1>
      <Field
        label={t("email")}
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={setEmail}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t("signInSend")}
      </button>
      {signup && (
        <a className="btn link" href="/signup">
          {t("createAccount")}
        </a>
      )}
    </AuthPage>
  );
}

/** After a link went out, for a sign-in, a signup or an invite. */
export function CheckEmail({ text, onBack }: { text: string; onBack?(): void }) {
  return (
    <AuthPage>
      <h1>{t("checkEmailTitle")}</h1>
      <p className="note" role="status">
        {text}
      </p>
      {onBack !== undefined && (
        <button type="button" className="btn link" onClick={onBack}>
          {t("useAnotherEmail")}
        </button>
      )}
    </AuthPage>
  );
}
