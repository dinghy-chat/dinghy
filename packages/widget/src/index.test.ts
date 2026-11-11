import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DinghyApi, QueuedCall } from "./shared.ts";

// Tests run in Node, which has no DOM. This fake keeps the script tags the package adds.
interface FakeScript {
  src: string;
  async: boolean;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}
let scripts: FakeScript[];
type Slot = { Dinghy?: DinghyApi | { q?: QueuedCall[] } };

beforeEach(() => {
  vi.resetModules();
  scripts = [];
  vi.stubGlobal("Dinghy", undefined);
  vi.stubGlobal("document", {
    createElement: () => ({
      src: "",
      async: false,
      attributes: {},
      setAttribute(this: FakeScript, name: string, value: string) {
        this.attributes[name] = value;
      },
    }),
    head: { append: (script: FakeScript) => scripts.push(script) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("init adds one loader tag with the options as data attributes, however often it runs", async () => {
  const { init } = await import("./index.ts");
  const options = {
    url: "https://chat.example.com",
    key: "wk_test",
    accent: "#e5352b",
    position: "left" as const,
    offsetY: 80,
    branding: false,
    launcher: false,
  };
  expect(init(options)).toBe(init(options));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.src).toBe("https://chat.example.com/widget/loader.js");
  expect(scripts[0]?.async).toBe(true);
  expect(scripts[0]?.attributes).toEqual({
    "data-key": "wk_test",
    "data-accent": "#e5352b",
    "data-position": "left",
    "data-offset-y": "80",
    "data-branding": "false",
    "data-launcher": "hidden",
  });
});

test("calls before the loader runs wait in its queue, and an early on() can still stop", async () => {
  const { init } = await import("./index.ts");
  const dinghy = init({ url: "https://chat.example.com/", key: "wk_test" });
  dinghy.open({ message: "Hi" });
  const heard: number[] = [];
  const stop = dinghy.on("unread", (count) => heard.push(count));
  expect(dinghy.state).toEqual({ ready: false, open: false, unread: 0 });

  const queue = (globalThis as Slot).Dinghy as { q: QueuedCall[] };
  expect(queue.q.map(([method]) => method)).toEqual(["open", "on"]);
  expect(queue.q[0]).toEqual(["open", { message: "Hi" }]);
  const listener = queue.q[1]?.[2] as (count: number) => void;
  listener(2);
  stop();
  listener(3);
  expect(heard).toEqual([2]);
});

test("once the loader runs, calls go straight to it", async () => {
  const { Dinghy } = await import("./index.ts");
  const calls: unknown[][] = [];
  const off = vi.fn();
  const real = {
    open: (...args: unknown[]) => calls.push(["open", ...args]),
    on: (...args: unknown[]) => {
      calls.push(["on", args[0]]);
      return off;
    },
    state: { ready: true, open: true, unread: 1 },
  };
  (globalThis as Record<string, unknown>).Dinghy = real;
  Dinghy.open();
  const stop = Dinghy.on("open", () => {});
  stop();
  expect(calls).toEqual([["open"], ["on", "open"]]);
  expect(off).toHaveBeenCalledOnce();
  expect(Dinghy.state).toEqual({ ready: true, open: true, unread: 1 });
});
