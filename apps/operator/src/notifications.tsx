/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { deleteDevice, saveDevice, testPush, type WorkspaceApi } from "./api.ts";
import { useLoad } from "./load.ts";
import { navigate } from "./nav.ts";
import { setSoundOn, soundOn } from "./sound.ts";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { ErrorNote, failureText, Loading, Page, PageRow } from "./ui.tsx";

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;

async function currentDevice(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Opens the conversation of a clicked notification, which the service worker sends to the open
 * app. A window that the click started asks for it too: on an iPhone it can start on its home page.
 */
export function followNotificationClicks() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const url: unknown = event.data?.type === "dinghy:open" ? event.data.url : null;
    // A window that the click started on the right address is already there.
    if (typeof url !== "string" || (event.data.started === true && url === location.href)) return;
    if (new URL(url, location.origin).origin === location.origin) navigate(url);
  });
  void navigator.serviceWorker.ready.then((registration) =>
    registration.active?.postMessage({ type: "dinghy:ready" }),
  );
}

/** Stops this browser's alerts before sign-out, because the next person here may be someone else. */
export async function leaveDevice(): Promise<void> {
  const device = await currentDevice().catch(() => null);
  if (device === null) return;
  await deleteDevice(device.endpoint).catch(() => {});
  await device.unsubscribe().catch(() => {});
}

// The server deletes a subscription that its push service dropped, and a browser can replace one.
export function useDeviceSync() {
  useEffect(() => {
    void currentDevice()
      .then((device) => (device === null ? undefined : saveDevice(device.toJSON())))
      .catch(() => {});
  }, []);
}

function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  const binary = atob(key.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Browser notifications on this device, for every workspace: turn them on, test them, or off. */
function PushRow({ pushKey }: { pushKey: string | null }) {
  const device = useLoad(() => currentDevice(), []);
  const [note, setNote] = useState<TextId | null>(null);

  const sendTest = async () => {
    setNote(null);
    const result = await testPush().catch(() => null);
    if (result !== null && result.sent > 0) toast("pushTestSent");
    else setNote("pushTestFailed");
  };

  const turnOn = async (key: string) => {
    setNote(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        setNote("pushDenied");
        return;
      }
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const created = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key),
      });
      await saveDevice(created.toJSON());
      device.setData(created);
      await sendTest();
    } catch {
      setNote("pushFailed");
    }
  };

  const turnOff = async () => {
    setNote(null);
    await leaveDevice();
    device.setData(null);
  };

  return (
    <PageRow
      title={t("pushThisDevice")}
      help={`${t("pushHelp")} ${t("pushNote")}`}
      docs={[{ path: "troubleshooting#alerts", text: "pushDocsLink" }]}
    >
      {pushKey === null ? (
        <p className="note">{t("pushNoKeys")}</p>
      ) : !pushSupported() ? (
        <p className="note">{t("pushUnsupported")}</p>
      ) : device.data === null ? (
        // A browser that cannot tell shows the button to turn alerts on.
        <button type="button" className="pill dark" onClick={() => void turnOn(pushKey)}>
          {t("pushOn")}
        </button>
      ) : (
        <div className="actions">
          <button type="button" className="pill dark" onClick={() => void sendTest()}>
            {t("pushTest")}
          </button>
          <button type="button" className="pill" onClick={() => void turnOff()}>
            {t("pushOff")}
          </button>
        </div>
      )}
      <ErrorNote text={note} />
    </PageRow>
  );
}

/** Notifications: browser notifications for every workspace, email for this one, and sound. */
export function NotificationsPage({ api }: { api: WorkspaceApi }) {
  const alerts = useLoad(() => api.alerts(), [api]);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [sound, setSound] = useState(soundOn);

  const setEmail = async (email: boolean) => {
    setFailure(null);
    try {
      alerts.setData(await api.setAlerts({ email }));
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };

  const settings = alerts.data;
  return (
    <Page title={t("pageNotifications")} context={t("notificationsContext")}>
      {settings === null ? (
        <Loading failure={alerts.failure} />
      ) : (
        <>
          <PushRow pushKey={settings.pushKey} />
          <PageRow
            title={t("email")}
            help={t(settings.emailAvailable ? "emailAlertsHelp" : "emailUnavailable")}
            docs={
              settings.emailAvailable
                ? []
                : [{ path: "self-hosting#settings", text: "emailDocsLink" }]
            }
          >
            {settings.emailAvailable && (
              <label className="check">
                {t("emailAlerts")}
                <input
                  type="checkbox"
                  checked={settings.email}
                  onChange={(event) => void setEmail(event.target.checked)}
                />
              </label>
            )}
            <ErrorNote text={failure} />
          </PageRow>
          <PageRow
            title={t("soundTitle")}
            help={t("soundHelp")}
            docs={[{ path: "operator-guide#get-alerts", text: "notificationsDocsLink" }]}
          >
            <label className="check">
              {t("soundToggle")}
              <input
                type="checkbox"
                checked={sound}
                onChange={(event) => {
                  setSoundOn(event.target.checked);
                  setSound(event.target.checked);
                }}
              />
            </label>
            <p className="hint">{t("soundNote")}</p>
          </PageRow>
        </>
      )}
    </Page>
  );
}
