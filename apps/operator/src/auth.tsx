/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import { askSignInLink, redeemJoinLink, redeemSignInLink } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { AuthPage, ErrorNote, Field, failureText } from "./ui.tsx";

export function SignIn({
  emailAvailable,
  signup = false,
}: {
  emailAvailable: boolean;
  signup?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<TextId | null>(null);
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

/** What an emailed link is for, as the server names it: the button's words and where it leads. */
const PURPOSES = {
  "sign-in": { button: "linkSignIn", again: "/" },
  signup: { button: "linkSignup", again: "/signup" },
  // Cloud signup with an email that has an account: sign in, then add a workspace.
  "add-workspace": { button: "linkSignIn", again: "/signup" },
  join: { button: "linkJoin", again: "/" },
} satisfies Record<string, { button: TextId; again: string }>;
type Purpose = keyof typeof PURPOSES;
const isPurpose = (value: string): value is Purpose => Object.hasOwn(PURPOSES, value);

/**
 * Every emailed link opens this page. Only its button uses the link, so a mail scanner that opens
 * links cannot use one up before its owner does.
 */
export function LinkPage({ purpose, token }: { purpose: string; token: string }) {
  const kind = isPurpose(purpose) ? purpose : "sign-in";
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (kind === "join") {
        const { workspaceId } = await redeemJoinLink(token);
        location.assign(`/?workspace=${workspaceId}`);
        return;
      }
      await redeemSignInLink(token);
      location.assign(kind === "add-workspace" ? "/signup" : "/");
    } catch (failure) {
      setBusy(false);
      setError(
        failureText(failure, { 400: "linkInvalid", 404: "inviteInvalid", 409: "emailTaken" }),
      );
    }
  };

  if (error === "linkInvalid") {
    return (
      <AuthPage>
        <ErrorNote text={error} />
        <a className="btn primary large" href={PURPOSES[kind].again}>
          {t("linkAskAgain")}
        </a>
      </AuthPage>
    );
  }
  return (
    <AuthPage onSubmit={submit}>
      <h1>{t("linkTitle")}</h1>
      <p className="note">{t("linkHelp")}</p>
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t(PURPOSES[kind].button)}
      </button>
    </AuthPage>
  );
}
