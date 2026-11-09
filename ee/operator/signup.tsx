// Licensed under the Dinghy Enterprise License. See ee/LICENSE.
/** @jsxImportSource react */
import { type FormEvent, useEffect, useState } from "react";
import {
  createWorkspace,
  getMe,
  type Me,
  signOut,
  signUp,
  startCheckout,
} from "../../apps/operator/src/api.ts";
import { CheckEmail } from "../../apps/operator/src/auth.tsx";
import { navigate } from "../../apps/operator/src/nav.ts";
import { type TextId, t } from "../../apps/operator/src/text.ts";
import { AuthPage, ErrorNote, Field, failureText } from "../../apps/operator/src/ui.tsx";
import { CHECKOUT_FAILURES } from "./billing.tsx";

const POLL_MS = 2000;
const POLL_FOR_MS = 2 * 60_000;

/** Opens Stripe Checkout, or the payment screen if Checkout cannot start. */
async function openCheckout(workspaceId: string): Promise<void> {
  const { url } = await startCheckout(workspaceId);
  navigate(url);
}

/**
 * Cloud signup's first step: the email. Its link signs in, to a new account or the one the email
 * already has, and the onboarding then names the operator and the workspace.
 */
export function Signup({ early }: { early: boolean }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signUp(email.trim());
      setSentTo(email.trim());
    } catch (failure) {
      setError(failureText(failure, { 429: "tooManyAttempts" }));
    } finally {
      setBusy(false);
    }
  };

  if (sentTo !== null) return <CheckEmail text={t("checkEmail")} email={sentTo} />;
  return (
    <AuthPage time="morning" onSubmit={submit}>
      <h1>{t("signupTitle")}</h1>
      {early && <p className="note">{t("signupEarly")}</p>}
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
        {t("signupSubmit")}
      </button>
      <button type="button" className="btn link" onClick={() => navigate("/")}>
        {t("haveAccount")}
      </button>
    </AuthPage>
  );
}

/**
 * Cloud signup's second step, for a signed-in operator: their name and a new workspace. With
 * `early`, the workspace opens at once. Otherwise it waits for payment, on Checkout next.
 */
export function Onboarding({
  early,
  initialName,
  onSignedOut,
}: {
  early: boolean;
  initialName: string;
  onSignedOut(): void;
}) {
  const [name, setName] = useState(initialName);
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    let workspaceId: string;
    try {
      ({ workspaceId } = await createWorkspace(name.trim(), workspaceName.trim()));
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, { 429: "tooManyAttempts" }));
      return;
    }
    if (early) {
      navigate(`/?workspace=${workspaceId}`);
      return;
    }
    // The workspace exists now, so a failed Checkout falls back to the payment screen.
    await openCheckout(workspaceId).catch(() => navigate(`/?workspace=${workspaceId}`));
  };

  return (
    <AuthPage time="afternoon" onSubmit={submit}>
      <h1>{t("onboardingTitle")}</h1>
      {!early && <p className="note">{t("signupHelp")}</p>}
      <Field
        label={t("yourName")}
        autoComplete="name"
        required
        maxLength={100}
        pattern=".*\S.*"
        value={name}
        onChange={setName}
      />
      <Field
        label={t("signupWorkspace")}
        hint={t("signupWorkspaceHint")}
        autoComplete="organization"
        required
        maxLength={100}
        pattern=".*\S.*"
        value={workspaceName}
        onChange={setWorkspaceName}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t("onboardingSubmit")}
      </button>
      <button
        type="button"
        className="btn link"
        onClick={() => void signOut().finally(onSignedOut)}
      >
        {t("signOut")}
      </button>
    </AuthPage>
  );
}

/** A workspace that waits for payment. Only its owner can pay. */
export function FinishPayment({
  workspace,
  others,
  onSwitch,
  onSignedOut,
}: {
  workspace: Me["workspaces"][number];
  /** The operator's paid workspaces, so this screen is never a dead end. */
  others: Me["workspaces"];
  onSwitch(id: string): void;
  onSignedOut(): void;
}) {
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setError(null);
    setBusy(true);
    try {
      await openCheckout(workspace.workspaceId);
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, CHECKOUT_FAILURES));
    }
  };
  return (
    <AuthPage time="afternoon">
      <h1>{t("payTitle")}</h1>
      <p className="note">{workspace.name}</p>
      {workspace.role === "owner" ? (
        <>
          <p className="note">{t("payHelp")}</p>
          <ErrorNote text={error} />
          <button
            type="button"
            className="btn primary large"
            disabled={busy}
            onClick={() => void pay()}
          >
            {t("payButton")}
          </button>
        </>
      ) : (
        <p className="note">{t("payNotOwner")}</p>
      )}
      {others.map((other) => (
        <button
          type="button"
          key={other.workspaceId}
          className="btn outline"
          onClick={() => onSwitch(other.workspaceId)}
        >
          {t("payOpenOther", { name: other.name })}
        </button>
      ))}
      <button
        type="button"
        className="btn outline"
        onClick={() => void signOut().finally(onSignedOut)}
      >
        {t("signOut")}
      </button>
    </AuthPage>
  );
}

/** Stripe sends the browser here. The webhook activates the workspace, usually within seconds. */
export function BillingReturn({ workspaceId }: { workspaceId: string }) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = async () => {
      const me = await getMe().catch(() => null);
      if (stopped) return;
      // Paying again for a read-only workspace also lands here.
      const ready = me?.workspaces.some(
        (one) => one.workspaceId === workspaceId && one.active && !one.readOnly,
      );
      if (ready) {
        navigate(`/?workspace=${workspaceId}`);
        return;
      }
      if (Date.now() - started >= POLL_FOR_MS) setTimedOut(true);
      else timer = setTimeout(() => void check(), POLL_MS);
    };
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [workspaceId]);

  return (
    <AuthPage time="afternoon">
      <h1>{t("payTitle")}</h1>
      {timedOut ? (
        <>
          <p className="note" role="status">
            {t("payStillProcessing")}
          </p>
          <button type="button" className="btn primary large" onClick={() => location.reload()}>
            {t("reload")}
          </button>
        </>
      ) : (
        <p className="note" role="status">
          {t("payPending")}
        </p>
      )}
    </AuthPage>
  );
}
