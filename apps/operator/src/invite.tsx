/** @jsxImportSource react */
import { type FormEvent, useState } from "react";
import {
  ApiError,
  acceptInvite,
  joinWithInvite,
  type Me,
  previewInvite,
  signOut,
  updateName,
} from "./api.ts";
import { CheckEmail } from "./auth.tsx";
import { useLoad } from "./load.ts";
import { navigate } from "./nav.ts";
import { AuthPage, SceneLoading } from "./scene.tsx";
import { type TextId, t } from "./text.ts";
import { ErrorNote, Field, failureText } from "./ui.tsx";

export function InvitePage({ token, me }: { token: string; me: Me | null }) {
  const preview = useLoad(() => previewInvite(token), [token]);
  const offer = preview.data;
  // Any failure reads as a link that no longer works.
  const invalid = preview.failure !== null;
  const [name, setName] = useState("");
  const [error, setError] = useState<TextId | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

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

  if (sentTo !== null) {
    return (
      <CheckEmail
        text={t("inviteCheckEmail", { workspace: offer?.workspaceName ?? "" })}
        email={sentTo}
      />
    );
  }
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
  // A forwarded link must not sign in to an account that may hold other workspaces, so an existing
  // account proves its mailbox first.
  return (
    <AuthPage time="morning" onSubmit={join}>
      {heading}
      {offer.hasAccount && <p className="note">{t("inviteHasAccount", words)}</p>}
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
        {offer.hasAccount ? t("inviteEmailLink") : t("inviteJoin", words)}
      </button>
    </AuthPage>
  );
}
