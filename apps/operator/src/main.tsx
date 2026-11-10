/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BillingReturn, FinishPayment, Onboarding, Signup } from "../../../ee/operator/signup.tsx";
import { getMe, getMeta, type Me, type Meta, signOut } from "./api.ts";
import { AccountDeleted, LinkPage, SignIn } from "./auth.tsx";
import { Inbox } from "./inbox.tsx";
import { InvitePage } from "./invite.tsx";
import { NAVIGATE_EVENT, navigate } from "./nav.ts";
import { t } from "./text.ts";
import { applyTheme, savedTheme } from "./theme.ts";
import { AuthPage, Scene, SceneLoading, ShellLoading, setLogoLinksHome } from "./ui.tsx";

applyTheme(savedTheme());

const WORKSPACE_KEY = "dinghy.workspace";

function rememberedWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function rememberWorkspace(id: string) {
  try {
    localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    // The choice lasts until the next page load.
  }
}

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
    addEventListener("popstate", moved);
    return () => {
      removeEventListener(NAVIGATE_EVENT, moved);
      removeEventListener("popstate", moved);
    };
  }, []);
  const signedOut = useCallback(() => setMe(null), []);
  // The workspace this operator just deleted, for a note in the next one.
  const [deletedName, setDeletedName] = useState<string | null>(null);
  const [accountDeleted, setAccountDeleted] = useState(false);
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
        initialName={me.name}
        onSignedOut={() => navigate("/")}
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
    history.replaceState(null, "", "/");
    setAt("/");
    setPicked(id);
  };
  // On the cloud, an account with no workspace finishes its signup, even after closing the tab.
  if (first === undefined && meta.signup !== null) {
    return (
      <Onboarding early={meta.signup === "early"} initialName={me.name} onSignedOut={signedOut} />
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
      </AuthPage>
    );
  }
  // A workspace that waits for the cloud keeps its dashboard, with a banner.
  if (!opens(first)) {
    return (
      <FinishPayment
        workspace={first}
        others={me.workspaces.filter(opens)}
        onSwitch={switchTo}
        onSignedOut={signedOut}
      />
    );
  }
  return (
    <Inbox
      key={first.workspaceId}
      me={me}
      workspaceId={first.workspaceId}
      canCreate={meta.signup !== null}
      emailAvailable={meta.email}
      onSignedOut={load}
      onSwitch={switchTo}
      onAccountChanged={load}
      deletedName={deletedName}
      onWorkspaceDeleted={(name) => {
        setDeletedName(name);
        navigate("/");
      }}
      onCloseDeleted={() => setDeletedName(null)}
      onAccountDeleted={() => setAccountDeleted(true)}
    />
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <Scene>
      <App />
    </Scene>,
  );
}
