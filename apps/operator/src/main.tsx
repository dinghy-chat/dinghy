/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BillingReturn, FinishPayment, Onboarding, Signup } from "../../../ee/operator/signup.tsx";
import { getMe, getMeta, type Me, type Meta, signOut } from "./api.ts";
import { AccountDeleted, LinkPage, SignIn } from "./auth.tsx";
import { ConsentPage, requestingApp } from "./consent.tsx";
import { Inbox } from "./inbox.tsx";
import { InvitePage } from "./invite.tsx";
import { NAVIGATE_EVENT, navigate, replaceAddress } from "./nav.ts";
import { DeleteAccount } from "./profile.tsx";
import { AuthPage, Scene, SceneLoading, ShellLoading, setLogoLinksHome } from "./scene.tsx";
import { readStored, store } from "./stored.ts";
import { t } from "./text.ts";
import { applyTheme, savedTheme } from "./theme.ts";
import { Toaster } from "./toast.tsx";

applyTheme(savedTheme());

const WORKSPACE_KEY = "dinghy.workspace";

const rememberedWorkspace = () => readStored(WORKSPACE_KEY);
const rememberWorkspace = (id: string) => store(WORKSPACE_KEY, id);

const here = () => `${location.pathname}${location.search}`;

function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");
  const [picked, setPicked] = useState<string | null>(null);
  // The address this render shows. It changes with the account, in one render, so a screen never
  // shows for a moment with the account from before the move.
  const [at, setAt] = useState(here);
  const load = useCallback(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const moved = () => {
      const next = here();
      const show = (account: Me | null) => {
        // A later move has its own answer coming. This one must not overwrite it.
        if (here() !== next) return;
        setMe(account);
        setAccountDeleted(false);
        // A new address can name a workspace, which wins over the last one picked.
        setPicked(null);
        setAt(next);
      };
      getMe().then(show, () => show(null));
    };
    addEventListener(NAVIGATE_EVENT, moved);
    return () => removeEventListener(NAVIGATE_EVENT, moved);
  }, []);
  const signedOut = useCallback(() => setMe(null), []);
  // The workspace this operator just deleted, for a note in the next one.
  const [deletedName, setDeletedName] = useState<string | null>(null);
  const [accountDeleted, setAccountDeleted] = useState(false);
  const accountGone = useCallback(() => setAccountDeleted(true), []);
  const workspaceDeleted = useCallback((name: string) => {
    setDeletedName(name);
    navigate("/");
  }, []);
  // Signup is open only on the cloud plan. A self-hosted server shows none.
  const [meta, setMeta] = useState<Meta | "loading">("loading");
  useEffect(() => {
    getMeta()
      .then((loaded) => {
        setLogoLinksHome(loaded.signup !== null);
        setMeta(loaded);
      })
      .catch(() => setMeta({ billing: false, signup: null, email: true }));
  }, []);

  const address = new URL(at, location.origin);
  const query = address.searchParams;
  const path = address.pathname;
  if (path === "/link") {
    return <LinkPage purpose={query.get("for") ?? ""} token={query.get("token") ?? ""} />;
  }
  if (accountDeleted) return <AccountDeleted />;
  if (me === "loading" || meta === "loading") {
    // An operator who used the app on this device most likely has it open again.
    return rememberedWorkspace() === null ? <SceneLoading /> : <ShellLoading />;
  }
  const inviteToken = query.get("token");
  if (path === "/invite" && inviteToken !== null) {
    return <InvitePage token={inviteToken} me={me} />;
  }
  if (path === "/oauth/authorize") {
    if (me !== null) return <ConsentPage request={address.search} me={me} />;
    // After the emailed link, sign-in comes back here with the same request.
    return (
      <SignIn
        emailAvailable={meta.email}
        signup={meta.signup !== null}
        returnTo={`${path}${address.search}`}
        reason={t("consentSignIn", { app: requestingApp(query) })}
      />
    );
  }
  const returnWorkspace = query.get("workspace");
  if (path === "/billing/return" && me !== null && returnWorkspace !== null) {
    return <BillingReturn workspaceId={returnWorkspace} />;
  }
  if (path === "/signup" && meta.signup !== null) {
    // A signed-in operator who signs up again adds a workspace.
    if (me === null) return <Signup early={meta.signup === "early"} />;
    return (
      <Onboarding
        early={meta.signup === "early"}
        me={me}
        emailAvailable={meta.email}
        onSignedOut={() => navigate("/")}
        onAccountDeleted={accountGone}
      />
    );
  }
  if (me === null) return <SignIn emailAvailable={meta.email} signup={meta.signup !== null} />;
  // A notification's link names its workspace, and otherwise the last one in use opens.
  const wanted = picked ?? query.get("workspace") ?? rememberedWorkspace();
  // With no choice, a workspace that opens before one that waits for payment.
  const opens = (one: Me["workspaces"][number]) => one.active || one.waiting;
  const first =
    me.workspaces.find((one) => one.workspaceId === wanted) ??
    me.workspaces.find(opens) ??
    me.workspaces[0];
  const switchTo = (id: string) => {
    setDeletedName(null);
    rememberWorkspace(id);
    // The conversation in the address belongs to the old workspace.
    replaceAddress("/");
    setAt("/");
    setPicked(id);
  };
  // On the cloud, an account with no workspace finishes its signup, even after closing the tab.
  if (first === undefined && meta.signup !== null) {
    return (
      <Onboarding
        early={meta.signup === "early"}
        me={me}
        emailAvailable={meta.email}
        onSignedOut={signedOut}
        onAccountDeleted={accountGone}
        deletedName={deletedName}
      />
    );
  }
  if (first === undefined) {
    return (
      <AuthPage>
        <p className="note">{t("noWorkspace")}</p>
        <button
          type="button"
          className="btn outline"
          onClick={() => void signOut().finally(signedOut)}
        >
          {t("signOut")}
        </button>
        {/* With no workspace there is no Profile page, so the account's delete is here. */}
        <DeleteAccount me={me} emailAvailable={meta.email} onDeleted={accountGone} />
      </AuthPage>
    );
  }
  // The workspace on screen is the one to come back to, also when a link opened it, so that
  // leaving the workspace setup with Cancel returns here. It writes only on a change.
  if (rememberedWorkspace() !== first.workspaceId) rememberWorkspace(first.workspaceId);
  // A workspace that waits for the cloud keeps its dashboard, with a banner.
  if (!opens(first)) {
    return (
      <FinishPayment
        key={first.workspaceId}
        me={me}
        workspace={first}
        others={me.workspaces.filter(opens)}
        emailAvailable={meta.email}
        onSwitch={switchTo}
        onSignedOut={signedOut}
        onWorkspaceDeleted={workspaceDeleted}
        onAccountDeleted={accountGone}
      />
    );
  }
  return (
    <Inbox
      // The operator too, so a sign-in as someone else in another tab cannot carry the drafts over.
      key={`${me.id}:${first.workspaceId}`}
      me={me}
      workspaceId={first.workspaceId}
      canCreate={meta.signup !== null}
      emailAvailable={meta.email}
      onSignedOut={load}
      onSwitch={switchTo}
      onAccountChanged={load}
      deletedName={deletedName}
      onWorkspaceDeleted={workspaceDeleted}
      onCloseDeleted={() => setDeletedName(null)}
      onAccountDeleted={accountGone}
    />
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <Scene>
      <App />
      <Toaster />
    </Scene>,
  );
}
