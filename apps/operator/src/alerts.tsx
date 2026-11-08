/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  type AlertSettings,
  deleteDevice,
  saveDevice,
  testPush,
  type WorkspaceApi,
} from "./api.ts";
import { type TextId, t } from "./text.ts";
import { ErrorNote, failureText, Loading, Page, PageRow, StatusNote } from "./ui.tsx";

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;

async function currentDevice(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
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

export function AlertsPage({ api }: { api: WorkspaceApi }) {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [device, setDevice] = useState<PushSubscription | null>(null);
  const [note, setNote] = useState<TextId | null>(null);
  const [failure, setFailure] = useState<TextId | null>(null);

  useEffect(() => {
    // An answer for a workspace this page no longer shows must not land here.
    let current = true;
    setFailure(null);
    api.alerts().then(
      (next) => {
        if (current) setSettings(next);
      },
      (error: unknown) => {
        if (current) setFailure(failureText(error, {}, "actionFailed"));
      },
    );
    // A browser that cannot tell shows the button to turn alerts on.
    currentDevice().then(
      (next) => {
        if (current) setDevice(next);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api]);

  const setEmail = async (email: boolean) => {
    setFailure(null);
    try {
      setSettings(await api.setAlerts({ email }));
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };

  const sendTest = async () => {
    const result = await testPush().catch(() => null);
    setNote(result !== null && result.sent > 0 ? "pushTestSent" : "pushTestFailed");
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
      setDevice(created);
      await sendTest();
    } catch {
      setNote("pushFailed");
    }
  };

  const turnOff = async () => {
    setNote(null);
    await leaveDevice();
    setDevice(null);
  };

  return (
    <Page title={t("alerts")} context={t("alertsContext")}>
      {settings === null ? (
        <Loading failure={failure} />
      ) : (
        <>
          <PageRow title={t("pushThisDevice")} help={t("pushNote")}>
            {settings.pushKey === null ? (
              <p className="note">{t("pushNoKeys")}</p>
            ) : !pushSupported() ? (
              <p className="note">{t("pushUnsupported")}</p>
            ) : device === null ? (
              <button
                type="button"
                className="pill dark"
                onClick={() => void turnOn(settings.pushKey ?? "")}
              >
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
            <StatusNote text={note} />
          </PageRow>
          <PageRow
            title={t("email")}
            help={settings.emailAvailable ? undefined : t("emailUnavailable")}
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
        </>
      )}
    </Page>
  );
}
