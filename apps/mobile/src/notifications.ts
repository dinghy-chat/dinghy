import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { t } from "../../operator/src/text.ts";
import type { DinghyApi } from "./api";
import type { NotificationRoute, PushProvider } from "./types";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function routeFromResponse(response: Notifications.NotificationResponse): NotificationRoute {
  const data = response.notification.request.content.data ?? {};
  const route: NotificationRoute = {};
  const workspaceId = safeId(data.workspaceId);
  const conversationId = safeId(data.conversationId);
  if (workspaceId) route.workspaceId = workspaceId;
  if (conversationId) route.conversationId = conversationId;
  if (typeof data.url === "string" && data.url.startsWith("/?")) route.url = data.url;
  return route;
}

function routeFromUrl(url?: string): NotificationRoute {
  if (!url) return {};
  try {
    const parsed = new URL(url, "https://dinghy.invalid");
    if (parsed.origin !== "https://dinghy.invalid" || parsed.pathname !== "/") return {};
    const route: NotificationRoute = {};
    const workspaceId = safeId(parsed.searchParams.get("workspace"));
    const conversationId = safeId(parsed.searchParams.get("conversation"));
    if (workspaceId) route.workspaceId = workspaceId;
    if (conversationId) route.conversationId = conversationId;
    return route;
  } catch {
    return {};
  }
}

export function conversationFromRoute(
  route: NotificationRoute,
  workspaceId: string,
): string | null {
  const normalized = route.conversationId ? route : routeFromUrl(route.url);
  if (!safeId(workspaceId) || !normalized.workspaceId || normalized.workspaceId !== workspaceId)
    return null;
  return normalized.conversationId ?? null;
}

export type PushRegistration = {
  refresh(requestPermission?: boolean): Promise<PushStatus>;
  unregister(): Promise<void>;
  dispose(): void;
};

export type PushStatus = "checking" | "enabled" | "denied" | "unavailable" | "error";

export type PushSetup = {
  status: Exclude<PushStatus, "checking">;
  registration: PushRegistration | null;
};

export async function registerForPush(
  api: DinghyApi,
  requestPermission = true,
): Promise<PushSetup> {
  const provider: PushProvider | null =
    Platform.OS === "ios" ? "apns" : Platform.OS === "android" ? "fcm" : null;
  if (provider === null) return { status: "unavailable", registration: null };
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("conversations", {
      name: t("resultConversations"),
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 100, 180],
    });
  }
  const tokens = new Set<string>();
  const register = async (token: Notifications.DevicePushToken): Promise<boolean> => {
    if (typeof token.data !== "string" || token.data.length === 0 || token.data.length > 4096)
      return false;
    await api.registerPush(provider, token.data);
    const old = [...tokens].filter((saved) => saved !== token.data);
    tokens.add(token.data);
    await Promise.allSettled(old.map((saved) => api.unregisterPush(provider, saved)));
    for (const saved of old) tokens.delete(saved);
    return true;
  };
  const refresh = async (ask = false): Promise<Exclude<PushStatus, "checking">> => {
    const settings = await api.alerts();
    if (!settings.nativePushProviders.includes(provider)) return "unavailable";
    const current = await Notifications.getPermissionsAsync();
    const permission =
      current.status === "granted"
        ? current
        : ask
          ? await Notifications.requestPermissionsAsync()
          : current;
    if (permission.status !== "granted") return "denied";
    return (await register(await Notifications.getDevicePushTokenAsync())) ? "enabled" : "error";
  };
  const status = await refresh(requestPermission);
  if (status !== "enabled") return { status, registration: null };
  const listener = Notifications.addPushTokenListener(
    (token) => void register(token).catch(() => undefined),
  );
  const registration: PushRegistration = {
    dispose: () => listener.remove(),
    refresh,
    unregister: async () => {
      listener.remove();
      await Promise.allSettled([...tokens].map((token) => api.unregisterPush(provider, token)));
      tokens.clear();
    },
  };
  return { status: "enabled", registration };
}

export async function coldStartRoute(): Promise<NotificationRoute | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (response === null) return null;
  await Notifications.clearLastNotificationResponseAsync();
  return routeFromResponse(response);
}

export function listenForNotificationRoutes(
  onRoute: (route: NotificationRoute) => void,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    onRoute(routeFromResponse(response));
  });
  return () => subscription.remove();
}
