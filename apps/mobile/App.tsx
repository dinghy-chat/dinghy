import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenStack, ScreenStackItem } from "react-native-screens";
import { t } from "../operator/src/text.ts";
import { createOutbox, type PendingReply } from "./outbox";
import { AnalyticsScreen } from "./src/analytics-screen";
import { ApiError, DinghyApi } from "./src/api";
import { clearSession, readSession, saveSession } from "./src/auth";
import { BottomNav, ErrorBanner, readableError, type TabPage } from "./src/common";
import { ContactsScreen } from "./src/contacts-screen";
import { fontFiles } from "./src/fonts";
import { InboxScreen, SettingsScreen } from "./src/inbox-screens";
import {
  coldStartRoute,
  conversationFromRoute,
  listenForNotificationRoutes,
  type PushRegistration,
  type PushStatus,
  registerForPush,
} from "./src/notifications";
import { SignInScreen } from "./src/sign-in-screen";
import { TabBarInsetContext } from "./src/tab-bar-inset";
import {
  day,
  displayTheme,
  night,
  type Palette,
  readThemePreference,
  saveThemePreference,
  styles,
  type ThemePreference,
} from "./src/theme";
import {
  closeThreadRoute,
  conversationBackEdge,
  openThreadRoute,
  type ThreadRoute,
} from "./src/thread-route";
import { ThreadScreen } from "./src/thread-screen";
import type { Conversation, Me, Member, NotificationRoute, Session, Thread } from "./src/types";
import { useReduceMotion } from "./src/use-reduce-motion";
import { VisitorsScreen } from "./src/visitors-screen";

const LIVE_COUNT_INTERVAL_MS = 30_000;
// Each screen draws its own header, so the native bar stays hidden.
const HIDDEN_HEADER = { hidden: true } as const;

/** The conversation on top of the tabs, with the draft it opened with. */
type OpenThread = ThreadRoute & { conversation: Conversation; initialDraft: string };

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

function SignedInApp({
  session: initialSession,
  onSignedOut,
  palette,
  theme,
  onTheme,
}: {
  session: Session;
  onSignedOut(): void;
  palette: Palette;
  theme: ThemePreference;
  onTheme(theme: ThemePreference): void;
}) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const iosThreadAnimation = reduceMotion ? "fade" : "simple_push";
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
  const [page, setPage] = useState<TabPage>("inbox");
  const [opened, setOpened] = useState<OpenThread | null>(null);
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const threadSerial = useRef(0);
  const isThreadOpen = opened !== null;
  const openedId = opened?.conversationId ?? null;
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const showLiveBadge = page !== "visitors" && !isThreadOpen;
  useEffect(() => {
    if (!showLiveBadge) return;
    let active = true;
    let pending = false;
    const read = async () => {
      if (AppState.currentState !== "active" || pending) return;
      pending = true;
      try {
        const { count } = await api.liveVisitorCount();
        if (active) setLiveCount(count);
      } catch {
        if (active) setLiveCount(null);
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(read, LIVE_COUNT_INTERVAL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void read();
    });
    return () => {
      active = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [api, showLiveBadge]);
  const [inboxQuery, setInboxQuery] = useState("");
  const [contactsQuery, setContactsQuery] = useState("");
  const [contactOpen, setContactOpen] = useState(false);
  const [tabBarHeight, setTabBarHeight] = useState(0);
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", () => setKeyboardShown(true));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboardShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // The dock floats over the list, which scrolls behind it. While the inbox search field is open,
  // the dock sits under the list instead, so the keyboard padding lifts it above the keyboard.
  const overlaysList =
    Platform.OS === "ios" &&
    !(page === "inbox" && keyboardShown) &&
    !(page === "contacts" && contactOpen);
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [waiting, setWaiting] = useState(0);
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
        if (scopeRef.current === requestScope && inboxRequest.current === request) {
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
        setOpened((current) =>
          current?.conversationId === conversationId
            ? { ...current, conversation: result.conversation }
            : current,
        );
        const newest = result.messages.at(-1)?.seq;
        if (newest) {
          // The stream sends no event for a read, so the row loses its dot here.
          void api.markRead(conversationId, newest).then(
            () =>
              setConversations((current) =>
                current.map((row) => (row.id === conversationId ? { ...row, unread: false } : row)),
              ),
            () => undefined,
          );
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
        // The newest request ends any load, also when a quiet refresh replaced the one that showed it.
        if (scopeRef.current === requestScope && threadRequest.current === request) {
          setThreadLoading(false);
        }
      }
    },
    [api, handleFailure, outbox, scopeKey],
  );

  // The tabs stay mounted under the conversation, so their search, scroll and open contact are
  // still there after Back. A second open of the conversation on top refreshes it in place.
  const openConversation = useCallback(
    (conversation: Conversation) => {
      Keyboard.dismiss();
      const current = openedRef.current;
      const route = openThreadRoute(current, conversation.id, threadSerial.current + 1);
      threadTarget.current = { scope: scopeKey, conversationId: conversation.id };
      if (route === current) {
        void loadThread(conversation.id, false);
        return;
      }
      threadSerial.current += 1;
      threadRequest.current += 1;
      let initialDraft = "";
      try {
        initialDraft = outbox.getDraft(conversation.id);
      } catch (failure) {
        setError(t("mobileReplySaveFailed", { error: readableError(failure) }));
      }
      const next = { ...route, conversation, initialDraft };
      openedRef.current = next;
      setOpened(next);
      setThread(null);
      void loadThread(conversation.id);
    },
    [loadThread, outbox, scopeKey],
  );

  // Back, Android's back button and a finished edge swipe all end here. A swipe that the operator
  // cancels never reports, so the conversation and its draft stay as they were.
  const closeThread = useCallback((key: string) => {
    if (closeThreadRoute(openedRef.current, key)) return;
    Keyboard.dismiss();
    threadTarget.current = null;
    threadRequest.current += 1;
    openedRef.current = null;
    setThreadLoading(false);
    setOpened(null);
    setThread(null);
  }, []);

  const openById = useCallback(
    (conversationId: string, isSavedReply = false) => {
      const found = conversations.find((item) => item.id === conversationId);
      const stub: Conversation = found ?? {
        id: conversationId,
        status: "open",
        updatedAt: new Date().toISOString(),
        assigneeOperatorId: null,
        visitor: {
          id: "",
          name: t(isSavedReply ? "mobileSavedReply" : "visitorAnonymous"),
          email: null,
          pictureUrl: null,
        },
        lastMessage: null,
        handler: null,
        unread: !isSavedReply,
        snooze: null,
      };
      openConversation(stub);
    },
    [conversations, openConversation],
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
          openedRef.current = null;
          setLiveCount(null);
          setPage("inbox");
          setOpened(null);
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
      openById(conversationId);
    },
    [api, handleFailure, openById, scopeKey, session],
  );

  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox]);

  // While the list shows, it refreshes every 30 seconds, and at once when the operator comes back
  // to it from a conversation or from another app. The first load shows its own spinner.
  const listShown = useRef(false);
  useEffect(() => {
    if (page !== "inbox" || isThreadOpen) return;
    if (listShown.current) void refreshInbox(false);
    listShown.current = true;
    const timer = setInterval(() => void refreshInbox(false), 30_000);
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshInbox(false);
    });
    return () => {
      clearInterval(timer);
      appState.remove();
    };
  }, [isThreadOpen, page, refreshInbox]);

  useEffect(() => {
    if (!openedId) return;
    const timer = setInterval(() => void loadThread(openedId, false), 15_000);
    return () => clearInterval(timer);
  }, [loadThread, openedId]);

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
        await api.reply(
          pending.conversationId,
          pending.clientId,
          pending.body,
          pending.replyToMessageId ?? undefined,
        );
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

  const send = async (conversationId: string, body: string, replyToMessageId: string | null) => {
    const target = threadTarget.current;
    if (!target || target.scope !== scopeKey || target.conversationId !== conversationId) {
      return;
    }
    let reply: PendingReply;
    try {
      reply = outbox.enqueue(conversationId, body, replyToMessageId);
    } catch (failure) {
      setError(t("mobileReplySaveFailed", { error: readableError(failure) }));
      throw failure;
    }
    setOutboxVersion((value) => value + 1);
    void deliver(reply);
  };

  const saveDraft = (conversationId: string, body: string) => {
    const target = threadTarget.current;
    if (!target || target.scope !== scopeKey || target.conversationId !== conversationId) {
      return;
    }
    try {
      outbox.saveDraft(conversationId, body);
    } catch (failure) {
      setError(t("mobileReplySaveFailed", { error: readableError(failure) }));
    }
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
    if (!target || target.scope !== scopeKey || !opened) return;
    try {
      const status =
        (thread?.conversation ?? opened.conversation).status === "open" ? "closed" : "open";
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

  const switchWorkspace = async (workspaceId: string) => {
    setInboxQuery("");
    setContactsQuery("");
    const workspace = me?.workspaces.find((item) => item.workspaceId === workspaceId);
    if (!workspace || workspace.workspaceId === session.workspace.id) return;
    const next = {
      ...session,
      workspace: { id: workspace.workspaceId, name: workspace.name },
    };
    try {
      await saveSession(next);
    } catch (failure) {
      setError(readableError(failure));
      return;
    }
    const nextScope = `${next.origin}\n${next.workspace.id}\n${next.operator.id}`;
    scopeRef.current = nextScope;
    inboxRequest.current += 1;
    threadRequest.current += 1;
    routeRequest.current += 1;
    threadTarget.current = null;
    pendingRoute.current = null;
    openedRef.current = null;
    setLiveCount(null);
    setPage("inbox");
    setOpened(null);
    setThread(null);
    setMe(null);
    setMembers([]);
    setConversations([]);
    setWaiting(0);
    setPendingErrors({});
    setInboxLoading(false);
    setThreadLoading(false);
    setSession(next);
  };

  const accountDeleted = async () => {
    push.current?.dispose();
    push.current = null;
    // The account is gone on the server, so the phone leaves it even if its storage fails.
    await clearSession().catch(() => undefined);
    Alert.alert(t("mobileDeleteAccountDeleted"));
    onSignedOut();
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

  const banner = error && (
    <ErrorBanner message={error} onDismiss={() => setError(null)} palette={palette} />
  );
  const workspace =
    me?.workspaces.find((item) => item.workspaceId === session.workspace.id) ?? null;

  return (
    <ScreenStack style={[styles.app, { backgroundColor: palette.paper }]}>
      <ScreenStackItem
        activityState={2}
        contentStyle={{ backgroundColor: palette.paper }}
        headerConfig={HIDDEN_HEADER}
        // The tabs end editing as a conversation covers them. This also closes the keyboard of the
        // native inbox search field, which Keyboard.dismiss does not reach.
        hideKeyboardOnSwipe
        screenId="tabs"
        style={StyleSheet.absoluteFill}
      >
        <View style={[styles.app, { paddingTop: insets.top }]}>
          {/* The tab's pixel sky continues behind the status bar. */}
          {!(page === "contacts" && contactOpen) && (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: insets.top,
                backgroundColor: page === "inbox" ? palette.cover : palette.analyticsSky,
              }}
            />
          )}
          {banner}
          <KeyboardAvoidingView
            style={styles.mainPage}
            behavior={Platform.OS === "ios" && page === "inbox" ? "padding" : undefined}
          >
            <TabBarInsetContext.Provider value={overlaysList ? tabBarHeight : 0}>
              <View style={styles.mainPage}>
                {page === "inbox" && (
                  <InboxScreen
                    conversations={conversations}
                    loading={inboxLoading}
                    me={me}
                    onOpen={openConversation}
                    onOpenPending={(id) => openById(id, true)}
                    onRefresh={() => refreshInbox(false)}
                    palette={palette}
                    pending={outbox.list()}
                    session={session}
                    meId={session.operator.id}
                    onAccount={() => setPage("settings")}
                    query={inboxQuery}
                    onClearSearch={() => setInboxQuery("")}
                    topInset={0}
                    waiting={waiting}
                  />
                )}
                {page === "contacts" && (
                  <ContactsScreen
                    api={api}
                    palette={palette}
                    topInset={0}
                    onDetailChange={setContactOpen}
                    query={contactsQuery}
                    onQuery={setContactsQuery}
                    readOnly={workspace?.readOnly ?? true}
                    onOpenConversation={(id) => openById(id)}
                  />
                )}
                {page === "visitors" && (
                  <VisitorsScreen
                    api={api}
                    palette={palette}
                    topInset={0}
                    isCovered={isThreadOpen}
                    onOpenConversation={(id) => openById(id)}
                    onCount={setLiveCount}
                  />
                )}
                {page === "analytics" && (
                  <AnalyticsScreen api={api} palette={palette} topInset={0} />
                )}
                {page === "settings" && (
                  <SettingsScreen
                    api={api}
                    session={session}
                    topInset={0}
                    me={me}
                    members={members}
                    onAway={changeAway}
                    onEnablePush={() =>
                      pushStatus === "denied" || pushStatus === "enabled"
                        ? void Linking.openSettings()
                        : void syncPush(true)
                    }
                    onProfileSaved={(account) => {
                      setMe(account);
                      setMembers((current) =>
                        current.map((member) =>
                          member.id === account.id
                            ? {
                                ...member,
                                name: account.name,
                                email: account.email,
                                pictureUrl: account.pictureUrl,
                              }
                            : member,
                        ),
                      );
                      const next = {
                        ...session,
                        operator: { ...session.operator, name: account.name },
                      };
                      setSession(next);
                      void saveSession(next).catch(() => undefined);
                    }}
                    onAccountDeleted={() => void accountDeleted()}
                    onSessionEnded={(failure) => void handleFailure(failure)}
                    onSignOut={signOut}
                    onWorkspace={(workspaceId) => void switchWorkspace(workspaceId)}
                    onWorkspaceRenamed={(name) => {
                      const next = { ...session, workspace: { ...session.workspace, name } };
                      setSession(next);
                      setMe((current) =>
                        current === null
                          ? current
                          : {
                              ...current,
                              workspaces: current.workspaces.map((workspace) =>
                                workspace.workspaceId === session.workspace.id
                                  ? { ...workspace, name }
                                  : workspace,
                              ),
                            },
                      );
                      void saveSession(next).catch(() => undefined);
                    }}
                    onTheme={onTheme}
                    palette={palette}
                    pushStatus={pushStatus}
                    signingOut={signingOut}
                    theme={theme}
                  />
                )}
              </View>
            </TabBarInsetContext.Provider>
            <View
              pointerEvents="box-none"
              style={overlaysList ? [StyleSheet.absoluteFill, { top: undefined }] : undefined}
              onLayout={
                overlaysList
                  ? (event) => setTabBarHeight(event.nativeEvent.layout.height)
                  : undefined
              }
            >
              <BottomNav
                liveCount={liveCount}
                onPage={(next) => {
                  setInboxQuery("");
                  setContactsQuery("");
                  setPage(next);
                }}
                query={inboxQuery}
                onQuery={setInboxQuery}
                page={page}
                palette={palette}
              />
            </View>
          </KeyboardAvoidingView>
        </View>
      </ScreenStackItem>
      {opened && (
        <ScreenStackItem
          key={opened.key}
          activityState={2}
          contentStyle={{ backgroundColor: palette.paper }}
          // Use the native pan transition only within the strip reserved for Back.
          customAnimationOnSwipe={Platform.OS === "ios"}
          fullScreenSwipeEnabled={Platform.OS === "ios"}
          gestureResponseDistance={{ end: conversationBackEdge }}
          stackAnimation={Platform.OS === "ios" ? iosThreadAnimation : "default"}
          headerConfig={HIDDEN_HEADER}
          hideKeyboardOnSwipe
          onDismissed={() => closeThread(opened.key)}
          replaceAnimation="push"
          screenId={opened.key}
          style={StyleSheet.absoluteFill}
        >
          <View style={[styles.app, { paddingTop: insets.top, backgroundColor: palette.paper }]}>
            {banner}
            <ThreadScreen
              api={api}
              bottomInset={insets.bottom}
              conversation={opened.conversation}
              loading={threadLoading}
              initialDraft={opened.initialDraft}
              meId={session.operator.id}
              members={members}
              workspace={workspace}
              onHandoff={assign}
              onAssign={() => assign(session.operator.id).catch(() => undefined)}
              onBack={() => closeThread(opened.key)}
              onDiscard={discard}
              onError={handleFailure}
              onReload={() => {
                if (threadTarget.current?.conversationId === opened.conversationId) {
                  void loadThread(opened.conversationId);
                }
              }}
              onRetry={deliver}
              onOpenConversation={(id) => openById(id)}
              onDraftChange={(body) => saveDraft(opened.conversationId, body)}
              onSend={(body, replyToMessageId) =>
                send(opened.conversationId, body, replyToMessageId)
              }
              onStatus={changeStatus}
              palette={palette}
              pending={outbox.list(opened.conversationId)}
              pendingErrors={pendingErrors}
              thread={thread}
            />
          </View>
        </ScreenStackItem>
      )}
    </ScreenStack>
  );
}

function AppContent() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const insets = useSafeAreaInsets();
  const systemTheme = useColorScheme();
  const [theme, setTheme] = useState<ThemePreference | undefined>(undefined);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const isNight = displayTheme(session != null, theme ?? "system", systemTheme) === "dark";
  const palette = isNight ? night : day;
  useEffect(() => {
    let active = true;
    void readThemePreference().then(
      (saved) => {
        if (active) setTheme(saved);
      },
      () => {
        if (active) setTheme("system");
      },
    );
    return () => {
      active = false;
    };
  }, []);
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
  const isReady =
    theme !== undefined && session !== undefined && (fontsLoaded || fontError !== null);
  useEffect(() => {
    if (isReady) SplashScreen.hide();
  }, [isReady]);
  if (!isReady) return null;
  return (
    <>
      <StatusBar barStyle={isNight ? "light-content" : "dark-content"} />
      {session === null ? (
        <SignInScreen
          topInset={insets.top}
          bottomInset={insets.bottom}
          onSignedIn={setSession}
          palette={palette}
        />
      ) : (
        <SignedInApp
          key={`${session.origin}-${session.workspace.id}-${session.operator.id}`}
          onSignedOut={() => setSession(null)}
          onTheme={(next) => {
            setTheme(next);
            void saveThemePreference(next).catch(() => undefined);
          }}
          palette={palette}
          session={session}
          theme={theme}
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
