/** @jsxImportSource react */
import { type FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  acceptInvite,
  joinWithInvite,
  type Me,
  previewInvite,
  updateName,
} from "./api.ts";
import { CheckEmail } from "./auth.tsx";
import { type TextId, t } from "./text.ts";
import { AuthPage, ErrorNote, Field, failureText, Loading, ROLE_TEXT } from "./ui.tsx";

export function InvitePage({ token, me }: { token: string; me: Me | null }) {
  const [offer, setOffer] = useState<{ workspaceName: string; role: "admin" | "agent" } | null>(
    null,
  );
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
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

  // The link joins, for a new account or one this email already has, and signs in.
  const join = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { signInUrl } = await joinWithInvite(token, name.trim(), email.trim());
      // A server with no mail server answers with the link itself.
      if (signInUrl !== null) {
        location.assign(signInUrl);
        return;
      }
      setSentTo(email.trim());
    } catch (failure) {
      setError(failureText(failure, { 409: "emailTaken", 404: "inviteInvalid" }));
    }
  };

  if (sentTo !== null) return <CheckEmail text={t("checkEmail").replace("{email}", sentTo)} />;
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
  return (
    <AuthPage onSubmit={join}>
      {heading}
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
        label={t("email")}
        required
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
      />
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large">
        {t("inviteJoin")}
      </button>
    </AuthPage>
  );
}
