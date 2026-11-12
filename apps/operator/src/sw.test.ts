import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

const source = await readFile(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

const listeners = new Map<string, Listener>();
const showNotification = vi.fn(async () => {});
const windows: { focus: () => Promise<void>; postMessage: (message: unknown) => void }[] = [];
const openWindow = vi.fn(async () => {});
const claim = vi.fn(async () => {});
const skipWaiting = vi.fn(async () => {});

beforeEach(() => {
  listeners.clear();
  showNotification.mockClear();
  openWindow.mockClear();
  windows.length = 0;
  new Function("self", source)({
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting,
    registration: { showNotification },
    location: { origin: "https://chat.example.com" },
    clients: { matchAll: async () => windows, openWindow, claim },
  });
});

async function push(data: unknown) {
  const pending: Promise<unknown>[] = [];
  listeners.get("push")?.({
    data,
    waitUntil: (work: Promise<unknown>) => pending.push(work),
  });
  await Promise.all(pending);
}

async function click(url?: string) {
  const pending: Promise<unknown>[] = [];
  const close = vi.fn();
  listeners.get("notificationclick")?.({
    notification: { close, data: url === undefined ? undefined : { url } },
    waitUntil: (work: Promise<unknown>) => pending.push(work),
  });
  await Promise.all(pending);
  expect(close).toHaveBeenCalled();
}

test("a push shows a notification with the event's tag", async () => {
  await push({
    json: () => ({ title: "Acme", body: "Hello", tag: "space:7", url: "/?conversation=c" }),
  });
  expect(showNotification).toHaveBeenCalledWith("Acme", {
    body: "Hello",
    tag: "space:7",
    icon: "/assets/icon.svg",
    data: { url: "/?conversation=c" },
  });
});

test.each([
  ["no data", null],
  [
    "data that is not JSON",
    {
      json: () => {
        throw new SyntaxError("bad");
      },
    },
  ],
])("a push with %s still shows a notification", async (_name, data) => {
  await push(data);
  expect(showNotification).toHaveBeenCalledOnce();
});

test("a click opens the conversation in a new window, which gets the address when it asks", async () => {
  const clicked = click("/?conversation=c");
  await vi.waitFor(() =>
    expect(openWindow).toHaveBeenCalledWith("https://chat.example.com/?conversation=c"),
  );
  // An iPhone can start the app on its home page, so the new window asks for the address.
  const reply = vi.fn();
  listeners.get("message")?.({ data: { type: "dinghy:ready" }, source: { postMessage: reply } });
  await clicked;
  expect(reply).toHaveBeenCalledWith({
    type: "dinghy:open",
    url: "https://chat.example.com/?conversation=c",
  });
});

test("a window that starts with no click waiting gets no address", () => {
  const reply = vi.fn();
  listeners.get("message")?.({ data: { type: "dinghy:ready" }, source: { postMessage: reply } });
  expect(reply).not.toHaveBeenCalled();
});

test("a click sends an open window to the conversation and brings it forward", async () => {
  const focus = vi.fn(async () => {});
  const postMessage = vi.fn();
  windows.push({ focus, postMessage });
  await click("/?conversation=c");
  expect(focus).toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({
    type: "dinghy:open",
    url: "https://chat.example.com/?conversation=c",
  });
  expect(openWindow).not.toHaveBeenCalled();
});

test("a click cannot open another site, whatever the push said", async () => {
  const postMessage = vi.fn();
  windows.push({ focus: async () => {}, postMessage });
  await click("https://evil.example/");
  expect(postMessage).toHaveBeenCalledWith({
    type: "dinghy:open",
    url: "https://chat.example.com",
  });
});

test("a new worker takes control of the tab that registered it", async () => {
  const pending: Promise<unknown>[] = [];
  listeners.get("activate")?.({ waitUntil: (work: Promise<unknown>) => pending.push(work) });
  await Promise.all(pending);
  expect(claim).toHaveBeenCalled();
});

test("a new worker does not wait for every open tab to close", async () => {
  const pending: Promise<unknown>[] = [];
  listeners.get("install")?.({ waitUntil: (work: Promise<unknown>) => pending.push(work) });
  await Promise.all(pending);
  expect(skipWaiting).toHaveBeenCalled();
});
