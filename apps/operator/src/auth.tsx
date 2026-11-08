/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import { requestReset, resetPassword, signIn } from "./api.ts";
import { type TextId, t } from "./text.ts";
import { AuthPage, ErrorNote, Field, failureText, StatusNote } from "./ui.tsx";

export function SignIn({ onDone, signup = false }: { onDone(): void; signup?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [mode, setMode] = useState<"signIn" | "forgot">("signIn");
  const [notice, setNotice] = useState<TextId | null>(null);

  const showMode = (next: "signIn" | "forgot") => {
    setError(null);
    setNotice(null);
    setMode(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await signIn(email.trim(), password);
      onDone();
    } catch (failure) {
      // 403: the right password on an account that has not confirmed its email yet.
      setError(
        failureText(failure, {
          429: "tooManyAttempts",
          401: "signInFailed",
          403: "emailNotVerified",
        }),
      );
    }
  };

  const forgot = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await requestReset(email.trim());
      setNotice("resetSent");
    } catch (failure) {
      setError(failureText(failure, { 429: "tooManyAttempts", 400: "resetNoMail" }));
    }
  };

  const emailField = (
    <Field
      label={t("email")}
      type="email"
      autoComplete="email"
      required
      value={email}
      onChange={setEmail}
    />
  );

  if (mode === "forgot") {
    return (
      <AuthPage onSubmit={forgot}>
        <h1>{t("resetTitle")}</h1>
        <p className="note">{t("resetHelp")}</p>
        {emailField}
        <ErrorNote text={error} />
        <StatusNote text={notice} />
        <button type="submit" className="btn primary large">
          {t("resetSend")}
        </button>
        <button type="button" className="btn link" onClick={() => showMode("signIn")}>
          {t("backToSignIn")}
        </button>
      </AuthPage>
    );
  }

  return (
    <AuthPage onSubmit={submit}>
      <h1>{t("signInTitle")}</h1>
      {emailField}
      <Field
        label={t("password")}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={setPassword}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large">
        {t("signIn")}
      </button>
      <button type="button" className="btn link" onClick={() => showMode("forgot")}>
        {t("forgot")}
      </button>
      {signup && (
        <a className="btn link" href="/signup">
          {t("createAccount")}
        </a>
      )}
    </AuthPage>
  );
}

/** After a signup or an invite, on a server that verifies emails. */
export function CheckEmail({ email }: { email: string }) {
  return (
    <AuthPage>
      <h1>{t("checkEmailTitle")}</h1>
      <p className="note">{t("checkEmail").replace("{email}", email)}</p>
    </AuthPage>
  );
}

export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<TextId | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await resetPassword(token, password);
      location.assign("/");
    } catch {
      setError("resetFailed");
    }
  };

  return (
    <AuthPage onSubmit={submit}>
      <h1>{t("resetTitle")}</h1>
      <Field
        label={t("newPassword")}
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={setPassword}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large">
        {t("setPassword")}
      </button>
    </AuthPage>
  );
}
