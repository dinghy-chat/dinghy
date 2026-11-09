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
import { navigate } from "./nav.ts";
import { type TextId, t } from "./text.ts";
import { AuthPage, ErrorNote, Field, failureText, SceneLoading } from "./ui.tsx";

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
      navigate(`/?workspace=${joined.workspaceId}`);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "operator_limit") {
        setError("operatorLimit");
      } else if (failure instanceof ApiError && failure.status === 409) {
        // Someone already in the workspace has nothing to do here.
        navigate("/");
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
        navigate(signInUrl);
        return;
      }
      setSentTo(email.trim());
    } catch (failure) {
      setError(failureText(failure, { 409: "emailTaken", 404: "inviteInvalid" }));
    }
  };

  if (sentTo !== null) return <CheckEmail text={t("checkEmail")} email={sentTo} />;
  if (invalid) {
    return (
      <AuthPage time="morning">
        <h1>{t("inviteInvalidTitle")}</h1>
        <p className="note">{t("inviteInvalidHelp")}</p>
        <button type="button" className="btn primary large" onClick={() => navigate("/")}>
          {t(me === null ? "linkSignIn" : "inviteOpenApp")}
        </button>
      </AuthPage>
    );
  }
  if (offer === null) return <SceneLoading />;
  const heading = (
    <>
      <h1>{t("inviteTitle")}</h1>
      <p className="note">
        {t(offer.role === "admin" ? "inviteAsAdmin" : "inviteAsAgent", {
          workspace: offer.workspaceName,
        })}
      </p>
    </>
  );
  if (me !== null) {
    return (
      <AuthPage time="morning" onSubmit={(event) => void accept(event)}>
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
    <AuthPage time="morning" onSubmit={join}>
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
