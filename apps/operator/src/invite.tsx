/** @jsxImportSource react */
import { type FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  acceptInvite,
  type InviteOffer,
  joinWithInvite,
  type Me,
  previewInvite,
  signOut,
  updateName,
} from "./api.ts";
import { CheckEmail } from "./auth.tsx";
import { navigate } from "./nav.ts";
import { AuthPage, SceneLoading } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { ErrorNote, Field, failureText } from "./ui.tsx";

export function InvitePage({ token, me }: { token: string; me: Me | null }) {
  const [offer, setOffer] = useState<InviteOffer | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState("");
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
      } else if (failure instanceof ApiError && failure.code === "invite_other_email") {
        setError("inviteOtherEmail");
      } else if (failure instanceof ApiError && failure.status === 409) {
        // Someone already in the workspace has nothing to do here.
        navigate("/");
      } else {
        setError("inviteInvalid");
      }
    }
  };

  // A new account joins and signs in at once. An existing one gets a link by email.
  const join = async (event: FormEvent) => {
    event.preventDefault();
    if (offer === null) return;
    setError(null);
    try {
      const joined = await joinWithInvite(token, offer.needsName ? name.trim() : undefined);
      if (joined.workspaceId !== null) {
        navigate(`/?workspace=${joined.workspaceId}`);
        return;
      }
      setSentTo(offer.email);
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
  const admin = offer.role === "admin";
  const words = { workspace: offer.workspaceName, inviter: offer.inviterName, email: offer.email };
  const heading = (
    <>
      <h1>{t("inviteTitle", words)}</h1>
      <p className="note">
        {offer.inviterName === ""
          ? t(admin ? "inviteForAdmin" : "inviteForMember", words)
          : t(admin ? "inviteByAdmin" : "inviteByMember", words)}
      </p>
    </>
  );
  if (me !== null && me.email.toLowerCase() !== offer.email) {
    return (
      <AuthPage time="morning">
        {heading}
        <p className="note">{t("inviteOtherAccount", { invited: offer.email, me: me.email })}</p>
        <button
          type="button"
          className="btn primary large"
          // The page loads again at the same invite, signed out.
          onClick={() => void signOut().finally(() => location.reload())}
        >
          {t("signOut")}
        </button>
      </AuthPage>
    );
  }
  if (me !== null) {
    return (
      <AuthPage time="morning" onSubmit={(event) => void accept(event)}>
        {heading}
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
          {t("inviteJoin", words)}
        </button>
      </AuthPage>
    );
  }
  return (
    <AuthPage time="morning" onSubmit={join}>
      {heading}
      {offer.needsName && (
        <Field
          label={t("yourName")}
          autoComplete="name"
          autoFocus
          required
          maxLength={100}
          pattern=".*\S.*"
          value={name}
          onChange={setName}
        />
      )}
      <ErrorNote text={error} />
      <button type="submit" className="btn primary large">
        {t("inviteJoin", words)}
      </button>
    </AuthPage>
  );
}
