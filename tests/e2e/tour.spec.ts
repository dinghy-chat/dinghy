import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, expect, type Locator, type Page, test } from "@playwright/test";
import { openLink } from "./links.ts";

// Records the product tour video of the operator app, from the demo workspace that `bun run seed`
// makes. It is not a test, so it runs only by hand, while `bun run dev` runs:
//   RECORD_TOUR=<directory> bun x playwright test tour --project=chromium
// It reseeds the demo, records the screen with an "Anna" cursor, and writes dinghy-tour.mp4 and
// dinghy-tour.jpg into the directory. It needs ffmpeg.
const directory = process.env.RECORD_TOUR;
test.skip(directory === undefined, "Set RECORD_TOUR to record");
test.setTimeout(240_000);

const PORT = Number(process.env.DINGHY_PORT ?? 3000);
const APP = `http://localhost:${PORT}`;
// The seed's site, which the demo workspace allows. The browser serves its page itself.
const SITE = "https://acme.example";
// The seed writes times of day in this zone, so the browser shows them in it too.
const TIME_ZONE = "Europe/Stockholm";
const VIEWPORT = { width: 1156, height: 686 };
const SCALE = 2;
const FPS = 25;
const CRF = 22;
const TYPE_DELAY_MS = 55;
const STEP_MS = 16;
const CURSOR_NAME = "Anna";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The cursor and its name pill, which follow the real mouse and shrink on a press. */
function cursorScript(name: string) {
  const draw = () => {
    if (document.getElementById("tour-cursor") !== null) return;
    const cursor = document.createElement("div");
    cursor.id = "tour-cursor";
    cursor.innerHTML = `<svg width="22" height="24" viewBox="0 0 22 24" style="display:block;filter:drop-shadow(0 1px 2px rgb(0 0 0 / .3))">
<path d="M2 2 L2 19.5 L7 15 L10.5 22.5 L13.6 21 L10.2 13.8 L17 13.5 Z" fill="#2f6bff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
<span style="position:absolute;left:16px;top:21px;padding:4px 11px;border-radius:999px;background:#2f6bff;color:#fff;font:600 13px/16px system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgb(0 0 0 / .25)">${name}</span>`;
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px, -100px)",
    });
    const svg = () => cursor.querySelector("svg");
    addEventListener(
      "mousemove",
      (event) => {
        cursor.style.transform = `translate(${event.clientX - 2}px, ${event.clientY - 2}px)`;
      },
      true,
    );
    addEventListener("mousedown", () => svg()?.style.setProperty("transform", "scale(.82)"), true);
    addEventListener("mouseup", () => svg()?.style.setProperty("transform", "none"), true);
    document.documentElement.append(cursor);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", draw);
  else draw();
}

/** Moves the mouse along a gentle arc, slow at both ends, as a hand does. */
/** Where the cursor rests at the start and the end. */
const START = { x: VIEWPORT.width * 0.62, y: VIEWPORT.height * 0.55 };

class Hand {
  private x = START.x;
  private y = START.y;
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async rest() {
    await this.page.mouse.move(this.x, this.y);
  }

  async glide(target: Locator | { x: number; y: number }, ms = 700) {
    const to = "x" in target ? target : await centerOf(target);
    const from = { x: this.x, y: this.y };
    const bend = Math.hypot(to.x - from.x, to.y - from.y) * 0.08;
    const started = Date.now();
    for (let t = 0; t < 1; ) {
      t = Math.min(1, (Date.now() - started) / ms);
      const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      const arc = Math.sin(Math.PI * eased) * bend;
      this.x = from.x + (to.x - from.x) * eased + arc;
      this.y = from.y + (to.y - from.y) * eased - arc;
      await this.page.mouse.move(this.x, this.y);
      await sleep(STEP_MS);
    }
  }

  async click(target: Locator, ms?: number) {
    await this.glide(target, ms);
    await sleep(120);
    await this.page.mouse.down();
    await sleep(90);
    await this.page.mouse.up();
  }
}

const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main menu" })
    .getByRole("button", { name: new RegExp(`^${name}`) });

async function centerOf(target: Locator) {
  const box = await target.boundingBox();
  if (box === null) throw new Error("The cursor's target is not on the screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** `bun run seed -- --live`, until stopped. Resolves with Anna's sign-in link once all is live. */
function startSeed(): Promise<{ link: string; seed: ChildProcess }> {
  const seed = spawn("node", ["apps/server/scripts/seed.ts", "--live"], {
    env: { ...process.env, TZ: TIME_ZONE },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    seed.on("exit", (code) => reject(new Error(`The seed stopped with code ${code}`)));
    seed.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const link = /^http\S+\/link\?\S+$/m.exec(output)?.[0];
      if (link !== undefined && output.includes("==> Live")) resolve({ link, seed });
    });
  });
}

/** Records the page with Chrome's screencast, as JPEGs and an ffmpeg list of their durations. */
async function recordScreen(page: Page, into: string) {
  const cdp = await page.context().newCDPSession(page);
  const frames: { file: string; at: number }[] = [];
  const writes: Promise<void>[] = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
    frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
    writes.push(writeFile(join(into, file), Buffer.from(data, "base64")));
    void cdp.send("Page.screencastFrameAck", { sessionId });
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: VIEWPORT.width * SCALE,
    maxHeight: VIEWPORT.height * SCALE,
  });
  return async () => {
    const end = Date.now() / 1000;
    await cdp.send("Page.stopScreencast");
    await Promise.all(writes);
    const lines = frames.map(
      ({ file, at }, index) => `file '${file}'\nduration ${(frames[index + 1]?.at ?? end) - at}`,
    );
    // The concat demuxer drops the last duration unless the last file comes again.
    await writeFile(
      join(into, "frames.txt"),
      `${lines.join("\n")}\nfile '${frames.at(-1)?.file}'\n`,
    );
  };
}

function encode(frames: string, video: string, poster: string) {
  const ffmpeg = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
  };
  // Chrome's JPEGs use the full range of values, and players expect the TV range.
  const size = `scale=${VIEWPORT.width}:${VIEWPORT.height}:flags=lanczos:in_range=full:out_range=tv`;
  ffmpeg([
    ...["-f", "concat", "-safe", "0", "-i", join(frames, "frames.txt")],
    ...["-vf", `${size},fps=${FPS},format=yuv420p`, "-an"],
    ...["-c:v", "libx264", "-preset", "slow", "-crf", String(CRF), "-movflags", "+faststart"],
    video,
  ]);
  ffmpeg(["-i", video, "-frames:v", "1", "-q:v", "3", poster]);
}

/** A hidden visitor on the pricing page, with the chat open, ready to write. */
async function visitorOnSite(browser: Browser, publicKey: string) {
  const context = await browser.newContext({ timezoneId: TIME_ZONE });
  const html = `<!doctype html><title>Pricing · Acme</title><h1>Pricing</h1>
<script src="${APP}/widget/loader.js" data-key="${publicKey}" async></script>`;
  await context.route(`${SITE}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  const visitor = await context.newPage();
  await visitor.goto(`${SITE}/pricing`);
  await visitor.getByRole("button", { name: "Open chat" }).click();
  return visitor.getByRole("textbox", { name: "Your message" });
}

/** Anna's workspace, from the operator API, for the key its widget loads with. */
async function workspaceKey(page: Page): Promise<string> {
  const waiting = await (await page.request.get(`${APP}/v1/operator/waiting`)).json();
  const workspaceId: string = waiting.workspaces[0].workspaceId;
  const settings = await page.request.get(`${APP}/v1/operator/workspaces/${workspaceId}/settings`);
  return (await settings.json()).publicKey;
}

/** Anna answers Maya, a new visitor writes in, and Anna hands that chat to Ben. */
async function inboxScene(page: Page, hand: Hand, visitorMessage: Locator) {
  await sleep(1400);
  await hand.click(page.getByRole("button", { name: /Maya Patel .*refund/ }), 900);
  await sleep(900);
  const reply = page.getByRole("textbox", { name: "Your reply" });
  await hand.click(reply, 700);
  await reply.pressSequentially(
    "Sorry about that, Maya! I've refunded the second $290 charge. It shows in 5 to 10 days.",
    { delay: TYPE_DELAY_MS },
  );
  await sleep(300);
  await hand.click(page.getByRole("button", { name: "Send", exact: true }), 500);
  await sleep(900);
  await visitorMessage.fill("Hi! Does the Team plan include SSO? We're about 40 people.");
  await visitorMessage.press("Enter");
  const incoming = page.getByRole("button", { name: /Does the Team plan include SSO/ });
  await incoming.waitFor();
  await hand.glide({ x: 560, y: 300 }, 800);
  await sleep(1400);
  await hand.click(incoming, 800);
  await sleep(1200);
  await hand.click(page.getByRole("button", { name: /^Who answers/ }), 800);
  await sleep(700);
  await hand.click(page.getByRole("option", { name: /Ben Okafor/ }), 700);
  await sleep(1500);
}

/** The live map, a dot's card and a row, then the 30-day chart with a bar's tip. */
async function visitorsAndAnalytics(page: Page, hand: Hand) {
  await hand.click(nav(page, "Visitors"), 900);
  await sleep(1200);
  await hand.glide(page.locator('.live-dot[aria-label^="United States"]'), 900);
  await sleep(2000);
  await hand.glide(page.locator('.live-dot[aria-label^="Germany"]'), 700);
  await sleep(1600);
  await hand.click(nav(page, "Analytics"), 1000);
  await sleep(1400);
  const bars = page.locator(".day-bar");
  const count = await bars.count();
  for (const index of [count - 9, count - 5, count - 1]) {
    await hand.glide(bars.nth(index), 650);
    await sleep(800);
  }
  await sleep(600);
}

/** The contacts, then back to the inbox as it began, so the video loops. */
async function contactsAndBack(page: Page, hand: Hand) {
  await hand.click(nav(page, "Contacts"), 900);
  await sleep(1200);
  for (const name of ["Maya Patel", "Tom Becker", "Lucas Silva"]) {
    await hand.glide(page.getByRole("row", { name: new RegExp(name) }), 600);
    await sleep(700);
  }
  await sleep(500);
  await hand.click(nav(page, "Inbox"), 1000);
  await sleep(400);
  // The back button, hidden in the wide layout, clears the chat so the inbox looks as it began.
  await page.locator(".thread-head .back").dispatchEvent("click");
  await hand.glide(START, 1100);
  await sleep(1400);
}

let seed: ChildProcess | undefined;
// After the test, even when it timed out, so the seed never outlives the recording.
test.afterAll(() => {
  seed?.kill("SIGINT");
});

test("record", async () => {
  if (directory === undefined) return;
  const frames = join(directory, "frames");
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  const started = await startSeed();
  seed = started.seed;
  // The site's page has a public address and the app is on localhost, which Chrome's private
  // network protection blocks. Only this recording turns it off; a real site never meets it.
  const browser = await chromium.launch({
    args: [
      "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      timezoneId: TIME_ZONE,
      locale: "en-US",
      // The app's CSP refuses inline styles, which the cursor's markup uses.
      bypassCSP: true,
    });
    await context.addInitScript(cursorScript, CURSOR_NAME);
    const page = await context.newPage();
    await openLink(page, started.link);
    await expect(page.getByRole("button", { name: /Maya Patel .*refund/ })).toBeVisible();
    const visitorMessage = await visitorOnSite(browser, await workspaceKey(page));
    const hand = new Hand(page);
    await hand.rest();
    await sleep(800);

    const stop = await recordScreen(page, frames);
    await inboxScene(page, hand, visitorMessage);
    await visitorsAndAnalytics(page, hand);
    await contactsAndBack(page, hand);
    await stop();
    encode(frames, join(directory, "dinghy-tour.mp4"), join(directory, "dinghy-tour.jpg"));
  } finally {
    await browser.close();
  }
});
