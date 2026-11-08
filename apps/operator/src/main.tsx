/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BillingReturn, FinishPayment, Onboarding, Signup } from "../../../ee/operator/signup.tsx";
import { getMe, getMeta, type Me, type Meta, signOut } from "./api.ts";
import { SignIn } from "./auth.tsx";
import { Inbox } from "./inbox.tsx";
import { InvitePage } from "./invite.tsx";
import { t } from "./text.ts";
import { AuthPage, Loading } from "./ui.tsx";

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

function App() {
  const [me, setMe] = useState<Me | null | "loading">("loading");
  const [picked, setPicked] = useState<string | null>(null);
  const load = useCallback(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(load, [load]);
  const signedOut = useCallback(() => setMe(null), []);
  // Signup is open only on the cloud plan. A self-hosted server shows none.
  const [meta, setMeta] = useState<Meta | "loading">("loading");
  useEffect(() => {
    getMeta()
      .then(setMeta)
      .catch(() => setMeta({ billing: false, signup: null, email: true }));
  }, []);

  if (me === "loading" || meta === "loading") return <Loading />;
  const inviteToken = new URLSearchParams(location.search).get("token");
  if (location.pathname === "/invite" && inviteToken !== null) {
    return <InvitePage token={inviteToken} me={me} />;
  }
  const returnWorkspace = new URLSearchParams(location.search).get("workspace");
  if (location.pathname === "/billing/return" && me !== null && returnWorkspace !== null) {
    return <BillingReturn workspaceId={returnWorkspace} />;
  }
  if (location.pathname === "/signup" && meta.signup !== null) {
    // A signed-in operator who signs up again adds a workspace.
    if (me === null) return <Signup />;
    return (
      <Onboarding
        early={meta.signup === "early"}
        initialName={me.name}
        onSignedOut={() => location.assign("/")}
      />
    );
  }
  if (me === null) return <SignIn emailAvailable={meta.email} signup={meta.signup !== null} />;
  // A notification's link names its workspace, and otherwise the last one in use opens.
  const wanted =
    picked ?? new URLSearchParams(location.search).get("workspace") ?? rememberedWorkspace();
  // With no choice, a workspace that opens before one that waits for payment.
  const opens = (one: Me["workspaces"][number]) => one.active || one.waiting;
  const first =
    me.workspaces.find((one) => one.workspaceId === wanted) ??
    me.workspaces.find(opens) ??
    me.workspaces[0];
  const switchTo = (id: string) => {
    rememberWorkspace(id);
    // The conversation in the address belongs to the old workspace.
    history.replaceState(null, "", "/");
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
      onSignedOut={load}
      onSwitch={switchTo}
      onAccountChanged={load}
    />
  );
}

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
