/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import { askSignInLink, redeemJoinLink, redeemSignInLink } from "./api.ts";
import { navigate } from "./nav.ts";
import { type TextId, t } from "./text.ts";
import { AppLink, AuthPage, ErrorNote, Field, failureText } from "./ui.tsx";

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
      <CheckEmail text={t("checkEmailSignIn")} email={sentTo} onBack={() => setSentTo(null)} />
    );
  }
  if (!emailAvailable) {
    return (
      <AuthPage time="morning">
        <h1>{t("signInTitle")}</h1>
        <ErrorNote text={error} />
        <p className="note">{t("signInNoMail")}</p>
      </AuthPage>
    );
  }
  return (
    <AuthPage time="morning" onSubmit={submit}>
      <h1>{t("signInTitle")}</h1>
      <p className="note">{t("signInHelp")}</p>
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
        <AppLink className="btn link" href="/signup">
          {t("createAccount")}
        </AppLink>
      )}
    </AuthPage>
  );
}

/** After a link went out, for a sign-in, a signup or an invite. */
export function CheckEmail({
  text,
  email,
  onBack,
}: {
  /** A sentence with `{email}` in it, where the address shows in bold to check for a typo. */
  text: string;
  email: string;
  onBack?(): void;
}) {
  const [before, after] = text.split("{email}");
  return (
    <AuthPage time="forenoon">
      <h1>{t("checkEmailTitle")}</h1>
      <p className="note" role="status">
        {before}
        <strong>{email}</strong>
        {after}
      </p>
      {onBack !== undefined && (
        <button type="button" className="btn link" onClick={onBack}>
          {t("useAnotherEmail")}
        </button>
      )}
    </AuthPage>
  );
}

/**
 * What an emailed link is for, as the server names it: the card's heading, the button's words and
 * where to ask for a new link.
 */
const PURPOSES = {
  "sign-in": { title: "linkWelcomeBack", button: "linkSignIn", again: "/" },
  signup: { title: "linkWelcome", button: "linkSignup", again: "/signup" },
  // Cloud signup with an email that has an account: sign in, then add a workspace.
  "add-workspace": { title: "linkWelcomeBack", button: "linkSignIn", again: "/signup" },
  // Only the invite makes a new join link, and the sign-in page cannot: the account may not exist.
  join: { title: "linkJoinTitle", button: "linkJoin", again: null },
} satisfies Record<string, { title: TextId; button: TextId; again: string | null }>;
type Purpose = keyof typeof PURPOSES;
/** The answers that use up a join link, unlike a lost connection, which leaves it to try again. */
const SPENT = new Set<TextId>(["inviteInvalid", "operatorLimit"]);
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
        navigate(`/?workspace=${workspaceId}`);
        return;
      }
      await redeemSignInLink(token);
      navigate(kind === "add-workspace" ? "/signup" : "/");
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, { 400: "linkInvalid", 404: "inviteInvalid" }));
    }
  };

  const { again } = PURPOSES[kind];
  // A refused join link is used up too, so its button would only say the link expired.
  if (error === "linkInvalid" || (again === null && error !== null && SPENT.has(error))) {
    return (
      <AuthPage time="noon">
        <ErrorNote text={again === null && error === "linkInvalid" ? "joinLinkInvalid" : error} />
        {again !== null && (
          <AppLink className="btn primary large" href={again}>
            {t("linkAskAgain")}
          </AppLink>
        )}
      </AuthPage>
    );
  }
  return (
    <AuthPage time="noon" onSubmit={submit}>
      <h1>{t(PURPOSES[kind].title)}</h1>
      <p className="note">{t("linkHelp")}</p>
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t(PURPOSES[kind].button)}
      </button>
    </AuthPage>
  );
}
