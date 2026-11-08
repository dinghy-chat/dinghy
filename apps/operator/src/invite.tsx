/** @jsxImportSource react */
import { type FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  acceptInvite,
  joinWithInvite,
  type Me,
  previewInvite,
  signIn,
  updateName,
} from "./api.ts";
import { CheckEmail, SignIn } from "./auth.tsx";
import { type TextId, t } from "./text.ts";
import { AuthPage, ErrorNote, Field, failureText, Loading, ROLE_TEXT } from "./ui.tsx";

export function InvitePage({
  token,
  me,
  onSignedIn,
}: {
  token: string;
  me: Me | null;
  onSignedIn(): void;
}) {
  const [offer, setOffer] = useState<{ workspaceName: string; role: "admin" | "agent" } | null>(
    null,
  );
  const [invalid, setInvalid] = useState(false);
  const [mode, setMode] = useState<"new" | "signIn">("new");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    previewInvite(token)
      .then(setOffer)
      .catch(() => setInvalid(true));
  }, [token]);

  const accept = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    try {
      // An account that signed up and never finished onboarding has no name yet.
      if (me?.name === "") await updateName(name.trim());
      const joined = await acceptInvite(token);
      location.assign(`/?workspace=${joined.workspaceId}`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "operator_limit") {
        setError("operatorLimit");
      } else if (failure instanceof ApiError && failure.status === 409) {
        // Someone already in the workspace has nothing to do here.
        location.assign("/");
      } else {
        setError("inviteInvalid");
      }
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { verify } = await joinWithInvite(token, name, email, password);
      if (verify) {
        setSentTo(email);
        return;
      }
      await signIn(email, password);
      location.assign("/");
    } catch (failure) {
      setError(failureText(failure, { 409: "emailTaken", 404: "inviteInvalid" }));
    }
  };

  if (sentTo !== null) return <CheckEmail email={sentTo} />;
  if (invalid) {
    return (
      <AuthPage>
        <ErrorNote text="inviteInvalid" />
      </AuthPage>
    );
  }
  if (offer === null) return <Loading />;
  const heading = (
    <>
      <h1>{t("inviteTitle")}</h1>
      <p className="note">
        {offer.workspaceName} {t("inviteAs")} {t(ROLE_TEXT[offer.role])}
      </p>
    </>
  );
  if (me !== null) {
    return (
      <AuthPage onSubmit={(event) => void accept(event)}>
        {heading}
        <p className="note">
          {t("inviteSignedInAs")} {me.email}
        </p>
        {me.name === "" && (
          <Field
            label={t("yourName")}
            required
            maxLength={100}
            // Spaces alone are not a name, and the server refuses them.
            pattern=".*\S.*"
            value={name}
            onChange={setName}
          />
        )}
        <ErrorNote text={error} />
        <button type="submit" className="btn primary large">
          {t("inviteJoin")}
        </button>
      </AuthPage>
    );
  }
  if (mode === "signIn") return <SignIn onDone={onSignedIn} />;
  return (
    <AuthPage onSubmit={create}>
      {heading}
      <Field label={t("yourName")} required value={name} onChange={setName} />
      <Field
        label={t("email")}
        required
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
      />
      <Field
        label={t("newPassword")}
        required
        type="password"
        minLength={10}
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large">
        {t("inviteJoin")}
      </button>
      <button type="button" className="btn link" onClick={() => setMode("signIn")}>
        {t("inviteHaveAccount")}
      </button>
    </AuthPage>
  );
}
