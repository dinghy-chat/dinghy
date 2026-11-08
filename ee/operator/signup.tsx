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
import { type TextId, t } from "../../apps/operator/src/text.ts";
import { AuthPage, ErrorNote, Field, failureText } from "../../apps/operator/src/ui.tsx";
import { CHECKOUT_FAILURES } from "./billing.tsx";

const POLL_MS = 2000;
const POLL_FOR_MS = 2 * 60_000;

/** Opens Stripe Checkout, or the payment screen if Checkout cannot start. */
async function openCheckout(workspaceId: string): Promise<void> {
  const { url } = await startCheckout(workspaceId);
  location.assign(url);
}

/**
 * Cloud signup's first step: the account. Then the onboarding names the operator and the
 * workspace, also for an existing account that signed in here to add one.
 */
export function Signup({ early }: { early: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedUp, setSignedUp] = useState<{ name: string } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { verify } = await signUp(email.trim(), password);
      // The link in the email signs the account in, and the onboarding follows.
      if (verify) {
        setSentTo(email.trim());
        return;
      }
    } catch (failure) {
      setBusy(false);
      setError(failureText(failure, { 409: "signupEmailTaken", 429: "tooManyAttempts" }));
      return;
    }
    // An existing account keeps its name in the form.
    const me = await getMe().catch(() => null);
    setSignedUp({ name: me?.name ?? "" });
  };

  if (sentTo !== null) return <CheckEmail email={sentTo} />;
  if (signedUp !== null) {
    return (
      <Onboarding
        early={early}
        initialName={signedUp.name}
        onSignedOut={() => location.assign("/")}
      />
    );
  }
  return (
    <AuthPage onSubmit={submit}>
      <h1>{t("signupTitle")}</h1>
      <Field
        label={t("email")}
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={setEmail}
      />
      <Field
        label={t("signupPassword")}
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        maxLength={128}
        value={password}
        onChange={setPassword}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large" disabled={busy}>
        {t("signupSubmit")}
      </button>
      <button type="button" className="btn link" onClick={() => location.assign("/")}>
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
      location.assign(`/?workspace=${workspaceId}`);
      return;
    }
    // The workspace exists now, so a failed Checkout falls back to the payment screen.
    await openCheckout(workspaceId).catch(() => location.assign(`/?workspace=${workspaceId}`));
  };

  return (
    <AuthPage onSubmit={submit}>
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
    <AuthPage>
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
          {t("payOpenOther").replace("{name}", other.name)}
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
        location.assign(`/?workspace=${workspaceId}`);
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
    <AuthPage>
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
