/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import { authorizeNativeSignIn, type Me } from "./api.ts";
import { AuthPage } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { ErrorNote, failureText } from "./ui.tsx";

const Base64Url32 = /^[A-Za-z0-9_-]{43}$/;

/** The explicit confirmation before the native app can receive an operator session. */
export function NativeSignIn({ query, me }: { query: URLSearchParams; me: Me }) {
  const codeChallenge = query.get("code_challenge") ?? "";
  const codeChallengeMethod = query.get("code_challenge_method") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  const state = query.get("state") ?? "";
  const isValid =
    Base64Url32.test(codeChallenge) &&
    codeChallengeMethod === "S256" &&
    redirectUri === "dinghy://auth/callback" &&
    Base64Url32.test(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextId | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await authorizeNativeSignIn({
        codeChallenge,
        codeChallengeMethod,
        redirectUri,
        state,
      });
      location.assign(redirectTo);
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, {}));
    }
  };

  if (!isValid) {
    return (
      <AuthPage>
        <h1>{t("nativeSignInInvalidTitle")}</h1>
        <p className="note">{t("nativeSignInInvalid")}</p>
      </AuthPage>
    );
  }
  return (
    <AuthPage onSubmit={submit}>
      <h1>{t("nativeSignInTitle")}</h1>
      <p className="note">{t("nativeSignInHelp", { name: me.name })}</p>
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t("nativeSignInApprove")}
      </button>
    </AuthPage>
  );
}
