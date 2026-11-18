import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Linking, StatusBar, useColorScheme, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { t } from "../operator/src/text.ts";
import { createOutbox, type PendingReply } from "./outbox";
import { ApiError, DinghyApi } from "./src/api";
import { clearSession, completeSignIn, readSession, saveSession } from "./src/auth";
import { BottomNav, ErrorBanner, type Page, readableError } from "./src/common";
import { fontFiles } from "./src/fonts";
import { InboxScreen, SearchScreen, SettingsScreen } from "./src/inbox-screens";
import {
  coldStartRoute,
  conversationFromRoute,
  listenForNotificationRoutes,
  type PushRegistration,
  type PushStatus,
  registerForPush,
} from "./src/notifications";
import { SignInScreen } from "./src/sign-in-screen";
import { day, night, type Palette, styles } from "./src/theme";
import { ThreadScreen } from "./src/thread-screen";
import type { Conversation, Me, Member, NotificationRoute, Session, Thread } from "./src/types";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

function SignedInApp({
  session: initialSession,
  onSignedOut,
  palette,
}: {
  session: Session;
  onSignedOut(): void;
  palette: Palette;
}) {
  const insets = useSafeAreaInsets();
  const [session, setSession] = useState(initialSession);
  const scopeKey = `${session.origin}\n${session.workspace.id}\n${session.operator.id}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const api = useMemo(() => new DinghyApi(session), [session]);
  const outbox = useMemo(
    () =>
      createOutbox({
        origin: session.origin,
        workspaceId: session.workspace.id,
        operatorId: session.operator.id,
      }),
    [session],
  );
  const [page, setPage] = useState<Page>("inbox");
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setOutboxVersion] = useState(0);
  const [pendingErrors, setPendingErrors] = useState<
    Record<string, { message: string; discardable: boolean }>
  >({});
  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");
  const [signingOut, setSigningOut] = useState(false);
  const pendingRoute = useRef<string | null>(null);
  const push = useRef<PushRegistration | null>(null);
  const consumedColdStart = useRef(false);
  const inboxRequest = useRef(0);
  const threadRequest = useRef(0);
  const routeRequest = useRef(0);
  const pushRequest = useRef(0);
  const threadTarget = useRef<{ scope: string; conversationId: string } | null>(null);

  const handleFailure = useCallback(
    async (failure: unknown) => {
      if (failure instanceof ApiError && failure.status === 401) {
        await clearSession();
        onSignedOut();
        return;
      }
      setError(readableError(failure));
    },
    [onSignedOut],
  );

  useEffect(() => {
    let active = true;
    setMembers([]);
    void api.members().then(
      (result) => {
        if (active) setMembers(result.members);
      },
      (failure) => {
        if (active) void handleFailure(failure);
      },
    );
    return () => {
      active = false;
    };
  }, [api, handleFailure]);

  const refreshInbox = useCallback(
    async (showLoading = true) => {
      const request = ++inboxRequest.current;
      const requestScope = scopeKey;
      if (showLoading) setInboxLoading(true);
      try {
        const [account, result] = await Promise.all([api.me(), api.conversations()]);
        if (scopeRef.current !== requestScope || inboxRequest.current !== request) return;
        setMe(account);
        setConversations(result.conversations);
        setWaiting(result.waiting);
      } catch (failure) {
        if (scopeRef.current === requestScope && inboxRequest.current === request) {
          await handleFailure(failure);
        }
      } finally {
        if (showLoading && scopeRef.current === requestScope && inboxRequest.current === request) {
          setInboxLoading(false);
        }
      }
    },
    [api, handleFailure, scopeKey],
  );

  const loadThread = useCallback(
    async (conversationId: string, showLoading = true) => {
      const request = ++threadRequest.current;
      const requestScope = scopeKey;
      if (showLoading) setThreadLoading(true);
      try {
        const result = await api.thread(conversationId);
        const target = threadTarget.current;
        if (
          scopeRef.current !== requestScope ||
          threadRequest.current !== request ||
          target?.scope !== requestScope ||
          target.conversationId !== conversationId
        ) {
          return;
        }
        setThread(result);
        setSelected(result.conversation);
        const newest = result.messages.at(-1)?.seq;
        if (newest) {
          void api.markRead(conversationId, newest).catch(() => undefined);
        }
      } catch (failure) {
        const target = threadTarget.current;
        if (
          scopeRef.current === requestScope &&
          threadRequest.current === request &&
          target?.scope === requestScope &&
          target.conversationId === conversationId
        ) {
          if (failure instanceof ApiError && [400, 403, 404, 422].includes(failure.status)) {
            const message = readableError(failure);
            setPendingErrors((current) => ({
              ...current,
              ...Object.fromEntries(
                outbox
                  .list(conversationId)
                  .map((reply) => [reply.clientId, { message, discardable: true }]),
              ),
            }));
          }
          await handleFailure(failure);
        }
      } finally {
        if (showLoading && scopeRef.current === requestScope && threadRequest.current === request) {
          setThreadLoading(false);
        }
      }
    },
    [api, handleFailure, outbox, scopeKey],
  );

  const openConversation = useCallback(
    (conversation: Conversation) => {
      threadTarget.current = { scope: scopeKey, conversationId: conversation.id };
      threadRequest.current += 1;
      setSelected(conversation);
      setThread(null);
      setPage("thread");
      void loadThread(conversation.id);
    },
    [loadThread, scopeKey],
  );

  const openRoute = useCallback(
    async (route: NotificationRoute) => {
      const request = ++routeRequest.current;
      if (route.workspaceId && route.workspaceId !== session.workspace.id) {
        try {
          const account = await api.me();
          if (routeRequest.current !== request || scopeRef.current !== scopeKey) return;
          const workspace = account.workspaces.find(
            (item) => item.workspaceId === route.workspaceId,
          );
          if (!workspace || !route.conversationId) return;
          pendingRoute.current = route.conversationId;
          const next = {
            ...session,
            workspace: { id: workspace.workspaceId, name: workspace.name },
          };
          await saveSession(next);
          if (routeRequest.current !== request || scopeRef.current !== scopeKey) return;
          const nextScope = `${next.origin}\n${next.workspace.id}\n${next.operator.id}`;
          scopeRef.current = nextScope;
          inboxRequest.current += 1;
          threadRequest.current += 1;
          threadTarget.current = null;
          setPage("inbox");
          setSelected(null);
          setThread(null);
          setInboxLoading(false);
          setThreadLoading(false);
          setConversations([]);
          setWaiting(0);
          setPendingErrors({});
          setSession(next);
        } catch (failure) {
          if (routeRequest.current === request && scopeRef.current === scopeKey) {
            await handleFailure(failure);
          }
        }
        return;
      }
      if (routeRequest.current !== request || scopeRef.current !== scopeKey) return;
      const conversationId = conversationFromRoute(route, session.workspace.id);
      if (!conversationId) return;
      const found = conversations.find((item) => item.id === conversationId);
      const stub: Conversation = found ?? {
        id: conversationId,
        status: "open",
        updatedAt: new Date().toISOString(),
        assigneeOperatorId: null,
        visitor: { id: "", name: t("visitorAnonymous"), email: null, pictureUrl: null },
        lastMessage: null,
        handler: null,
        unread: true,
        snooze: null,
      };
      openConversation(stub);
    },
    [api, conversations, handleFailure, openConversation, scopeKey, session],
  );

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  useEffect(() => {
    if (page !== "inbox") return;
    const timer = setInterval(() => void refreshInbox(false), 30_000);
    return () => clearInterval(timer);
  }, [page, refreshInbox]);

  useEffect(() => {
    if (page !== "thread" || !selected) return;
    const timer = setInterval(() => void loadThread(selected.id, false), 15_000);
    return () => clearInterval(timer);
  }, [loadThread, page, selected]);

  const syncPush = useCallback(
    async (requestPermission: boolean) => {
      const request = ++pushRequest.current;
      const requestScope = scopeKey;
      setPushStatus("checking");
      try {
        if (push.current) {
          const status = await push.current.refresh(requestPermission);
          if (status === "denied" || status === "unavailable") {
            await push.current.unregister();
            push.current = null;
          }
          if (pushRequest.current === request && scopeRef.current === requestScope) {
            setPushStatus(status);
          }
          return;
        }
        const setup = await registerForPush(api, requestPermission);
        if (pushRequest.current !== request || scopeRef.current !== requestScope) {
          setup.registration?.dispose();
          return;
        }
        push.current = setup.registration;
        setPushStatus(setup.status);
      } catch (failure) {
        if (pushRequest.current !== request || scopeRef.current !== requestScope) return;
        if (
          failure instanceof ApiError &&
          failure.status === 409 &&
          failure.code === "push_unavailable"
        ) {
          setPushStatus("unavailable");
          return;
        }
        if (failure instanceof ApiError && failure.status === 401) {
          await handleFailure(failure);
          return;
        }
        setPushStatus("error");
      }
    },
    [api, handleFailure, scopeKey],
  );

  useEffect(() => {
    push.current?.dispose();
    push.current = null;
    void syncPush(true);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncPush(false);
    });
    return () => {
      appState.remove();
      push.current?.dispose();
      push.current = null;
    };
  }, [syncPush]);

  useEffect(() => {
    const target = pendingRoute.current;
    if (!target) return;
    pendingRoute.current = null;
    void openRoute({ workspaceId: session.workspace.id, conversationId: target });
  }, [openRoute, session.workspace.id]);

  useEffect(() => {
    if (!consumedColdStart.current) {
      consumedColdStart.current = true;
      void coldStartRoute().then((route) => {
        if (route) void openRoute(route);
      });
    }
    return listenForNotificationRoutes((route) => void openRoute(route));
  }, [openRoute]);

  const deliver = async (reply: PendingReply) => {
    const deliveryScope = scopeKey;
    setOutboxVersion((value) => value + 1);
    try {
      await outbox.deliver(reply, async (pending) => {
        await api.reply(pending.conversationId, pending.clientId, pending.body);
      });
      if (scopeRef.current !== deliveryScope) return;
      setPendingErrors((current) => {
        const next = { ...current };
        delete next[reply.clientId];
        return next;
      });
      setOutboxVersion((value) => value + 1);
      if (threadTarget.current?.conversationId === reply.conversationId) {
        await loadThread(reply.conversationId);
      }
      await refreshInbox();
    } catch (failure) {
      if (scopeRef.current !== deliveryScope) return;
      setOutboxVersion((value) => value + 1);
      if (failure instanceof ApiError && failure.status === 401) {
        await handleFailure(failure);
        return;
      }
      const message = readableError(failure);
      const discardable =
        failure instanceof ApiError && [400, 403, 404, 422].includes(failure.status);
      setPendingErrors((current) => ({
        ...current,
        [reply.clientId]: { message, discardable },
      }));
      setError(t("mobileReplySaved", { error: readableError(failure) }));
    }
  };

  const send = async (body: string) => {
    const target = threadTarget.current;
    if (!target || target.scope !== scopeKey) return;
    let reply: PendingReply;
    try {
      reply = outbox.enqueue(target.conversationId, body);
    } catch (failure) {
      setError(t("mobileReplySaveFailed", { error: readableError(failure) }));
      throw failure;
    }
    setOutboxVersion((value) => value + 1);
    await deliver(reply);
  };

  const discard = (reply: PendingReply) => {
    Alert.alert(t("mobileDiscardTitle"), t("mobileDiscardText"), [
      { text: t("mobileKeepReply"), style: "cancel" },
      {
        text: t("draftDiscard"),
        style: "destructive",
        onPress: () => {
          if (!outbox.discard(reply)) return;
          setPendingErrors((current) => {
            const next = { ...current };
            delete next[reply.clientId];
            return next;
          });
          setOutboxVersion((value) => value + 1);
        },
      },
    ]);
  };

  const openPending = (conversationId: string) => {
    const found = conversations.find((conversation) => conversation.id === conversationId);
    openConversation(
      found ?? {
        id: conversationId,
        status: "open",
        updatedAt: new Date().toISOString(),
        assigneeOperatorId: null,
        visitor: { id: "", name: t("mobileSavedReply"), email: null, pictureUrl: null },
        lastMessage: null,
        handler: null,
        unread: false,
        snooze: null,
      },
    );
  };

  const assign = async (operatorId: string) => {
    const target = threadTarget.current;
    if (!target || target.scope !== scopeKey) return;
    try {
      await api.assign(target.conversationId, operatorId);
      if (threadTarget.current === target) await loadThread(target.conversationId);
      if (scopeRef.current === scopeKey) await refreshInbox();
    } catch (failure) {
      if (scopeRef.current === scopeKey && threadTarget.current === target) {
        await handleFailure(failure);
      }
      throw failure;
    }
  };

  const changeStatus = async () => {
    const target = threadTarget.current;
    if (!target || target.scope !== scopeKey || !selected) return;
    try {
      const status = (thread?.conversation ?? selected).status === "open" ? "closed" : "open";
      await api.setStatus(target.conversationId, status);
      if (threadTarget.current === target) await loadThread(target.conversationId);
      if (scopeRef.current === scopeKey) await refreshInbox();
    } catch (failure) {
      if (scopeRef.current === scopeKey && threadTarget.current === target) {
        await handleFailure(failure);
      }
    }
  };

  const changeAway = async () => {
    try {
      const answer = await api.setAway(!(me?.away ?? false));
      setMe((current) => current && { ...current, away: answer.away });
    } catch (failure) {
      await handleFailure(failure);
    }
  };

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.signOut();
    } catch (failure) {
      if (!(failure instanceof ApiError && failure.status === 401)) {
        setError(t("mobileSignOutFailed"));
        setSigningOut(false);
        return;
      }
    }
    push.current?.dispose();
    push.current = null;
    await clearSession();
    onSignedOut();
  };

  return (
    <View
      style={[
        styles.app,
        { paddingTop: page === "thread" || error ? insets.top : 0, backgroundColor: palette.paper },
      ]}
    >
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} palette={palette} />}
      {page === "thread" && selected ? (
        <ThreadScreen
          key={`${scopeKey}:${selected.id}`}
          bottomInset={insets.bottom}
          conversation={selected}
          loading={threadLoading}
          meId={session.operator.id}
          members={members}
          onHandoff={assign}
          onAssign={() => assign(session.operator.id).catch(() => undefined)}
          onBack={() => {
            threadTarget.current = null;
            threadRequest.current += 1;
            setThreadLoading(false);
            setPage("inbox");
            setSelected(null);
            setThread(null);
          }}
          onDiscard={discard}
          onReload={() => loadThread(selected.id)}
          onRetry={deliver}
          onSend={send}
          onStatus={changeStatus}
          palette={palette}
          pending={outbox.list(selected.id)}
          pendingErrors={pendingErrors}
          thread={thread}
        />
      ) : (
        <>
          <View style={styles.mainPage}>
            {page === "inbox" && (
              <InboxScreen
                conversations={conversations}
                loading={inboxLoading}
                me={me}
                onOpen={openConversation}
                onOpenPending={openPending}
                onRefresh={() => void refreshInbox()}
                palette={palette}
                pending={outbox.list()}
                session={session}
                meId={session.operator.id}
                onAccount={() => setPage("settings")}
                onSearch={() => setPage("search")}
                topInset={error ? 0 : insets.top}
                waiting={waiting}
              />
            )}
            {page === "search" && (
              <SearchScreen
                me={me}
                session={session}
                topInset={error ? 0 : insets.top}
                conversations={conversations}
                onOpen={openConversation}
                palette={palette}
              />
            )}
            {page === "settings" && (
              <SettingsScreen
                session={session}
                topInset={error ? 0 : insets.top}
                me={me}
                onAway={changeAway}
                onEnablePush={() =>
                  pushStatus === "denied" ? void Linking.openSettings() : void syncPush(true)
                }
                onSignOut={signOut}
                palette={palette}
                pushStatus={pushStatus}
                signingOut={signingOut}
              />
            )}
          </View>
          <BottomNav page={page} palette={palette} onPage={setPage} />
        </>
      )}
    </View>
  );
}

function AppContent() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const insets = useSafeAreaInsets();
  const isNight = useColorScheme() === "dark";
  const palette = isNight ? night : day;
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void readSession().then(
      (storedSession) => {
        if (active) setSession(storedSession);
      },
      () => {
        if (active) setSession(null);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const isReady = session !== undefined && (fontsLoaded || fontError !== null);
  useEffect(() => {
    if (isReady) SplashScreen.hide();
  }, [isReady]);
  useEffect(() => {
    if (session !== null) return;
    let active = true;
    const finish = async (url: string) => {
      try {
        const signedIn = await completeSignIn(url);
        if (active && signedIn) {
          setAuthError(null);
          setSession(signedIn);
        }
      } catch (failure) {
        if (active) setAuthError(readableError(failure));
      }
    };
    void Linking.getInitialURL().then((url) => {
      if (url) void finish(url);
    });
    const listener = Linking.addEventListener("url", ({ url }) => void finish(url));
    return () => {
      active = false;
      listener.remove();
    };
  }, [session]);
  if (!isReady) return null;
  return (
    <>
      <StatusBar barStyle={isNight ? "light-content" : "dark-content"} />
      {session === null ? (
        <SignInScreen
          topInset={insets.top}
          bottomInset={insets.bottom}
          completionError={authError}
          isNight={isNight}
          onStart={() => setAuthError(null)}
          palette={palette}
        />
      ) : (
        <SignedInApp
          key={`${session.origin}-${session.workspace.id}-${session.operator.id}`}
          onSignedOut={() => setSession(null)}
          palette={palette}
          session={session}
        />
      )}
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
