// Makes the App Store screenshots of the Dinghy Chat app. apps/mobile/STORE.md gives the steps.
//
//   node apps/mobile/scripts/store-screenshots.ts capture --app <DinghyChat.app>   (on a Mac)
//   node apps/mobile/scripts/store-screenshots.ts compose
//
// `capture` installs a Release simulator build on an iPhone 6.9" simulator, signs in to the local
// server with the seeded Harbor Coffee owner and runs store/screenshots.yaml with Maestro, which
// saves the raw screens. `compose` puts each raw screen under its headline at 1320 x 2868 pixels.
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { SLIDES } from "../store/listing.ts";

const MOBILE = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(MOBILE, "../..");
const RAW = join(MOBILE, "store/output/raw");
const COMPOSED = join(MOBILE, "store/output/composed/iphone-6.9");
/** Apple's size for the 6.9" iPhone, which App Store Connect scales down for smaller iPhones. */
const WIDTH = 1320;
const HEIGHT = 2868;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: "string" },
    device: { type: "string", default: "iPhone 17 Pro Max" },
    email: { type: "string", default: "owner@harborcoffee.example" },
    code: { type: "string", default: process.env.APP_REVIEW_CODE ?? "" },
  },
});

const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

function deviceId(name: string): string {
  const list = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "-j"])) as {
    devices: Record<string, { name: string; udid: string }[]>;
  };
  const device = Object.values(list.devices)
    .flat()
    .find((one) => one.name === name);
  if (device === undefined) throw new Error(`No available simulator named ${name}`);
  return device.udid;
}

function capture() {
  if (values.app === undefined) throw new Error("Pass --app with the Release simulator build");
  if (values.code === "") throw new Error("Pass --code or set APP_REVIEW_CODE");
  const udid = deviceId(values.device);
  try {
    run("xcrun", ["simctl", "boot", udid]);
  } catch {
    // The simulator was already booted.
  }
  run("xcrun", ["simctl", "bootstatus", udid]);
  run("xcrun", ["simctl", "ui", udid, "appearance", "light"]);
  run("xcrun", [
    "simctl",
    "status_bar",
    udid,
    "override",
    "--time",
    "9:41",
    "--dataNetwork",
    "wifi",
    "--wifiBars",
    "3",
    "--cellularBars",
    "4",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
  ]);
  try {
    run("xcrun", ["simctl", "uninstall", udid, "chat.dinghy.operator"]);
  } catch {
    // The app was not installed.
  }
  run("xcrun", ["simctl", "install", udid, values.app]);
  // The keychain outlives the app, and an old session can point at a workspace a new seed replaced.
  run("xcrun", ["simctl", "keychain", udid, "reset"]);
  rmSync(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });
  execFileSync(
    "maestro",
    [
      "--device",
      udid,
      "test",
      "--test-output-dir",
      RAW,
      join(MOBILE, "store/screenshots.yaml"),
      "-e",
      `EMAIL=${values.email}`,
      "-e",
      `CODE=${values.code}`,
    ],
    { stdio: "inherit" },
  );
  // Maestro saves the screens in a folder per run, under takeScreenshot.
  for (const file of globSync(join(RAW, "*/screenshots/takeScreenshot/*.png"))) {
    renameSync(file, join(RAW, basename(file)));
  }
  run("xcrun", ["simctl", "status_bar", udid, "clear"]);
  console.log(`Raw screens in ${RAW}`);
}

const asBase64 = (path: string) => readFileSync(path).toString("base64");
const font = (file: string) =>
  `data:font/woff2;base64,${asBase64(join(ROOT, "site/public/fonts", file))}`;

/**
 * The welcome screen's art: a yellow sky over a pixel sea. Every slide shows its own part of one
 * scene five slides wide, so the slides join up as the visitor swipes.
 */
const ART = `data:image/png;base64,${asBase64(join(MOBILE, "assets/sign-in-morning.png"))}`;
/** The art is drawn twice its size, and its horizon (y 648) sits at this height. */
const ART_SCALE = 2;
const HORIZON = 1560;
/** A stretch of the art's sea with nothing on it, repeated along the scene. */
const SEA = { x: 2350, y: 648, width: 458, height: 648 };
/** Sprites cut from the art, in its pixels, and where each sits in the scene. A sprite that crosses
 * the edge between two slides shows half in each, which joins the slides. */
const SPRITES = [
  { x: 1905, y: 421, width: 401, height: 227, at: WIDTH - 400 },
  { x: 1263, y: 600, width: 282, height: 262, at: 2 * WIDTH - 282 },
  { x: 140, y: 513, width: 321, height: 137, at: 3 * WIDTH - 321, lift: 820 },
  { x: 702, y: 541, width: 120, height: 109, at: 4 * WIDTH - 120 },
  { x: 1624, y: 513, width: 221, height: 89, at: 5 * WIDTH - 620, lift: 760 },
];

function sprite({ x, y, width, height, at, lift = 0 }: (typeof SPRITES)[number]): string {
  const top = HORIZON + (y - SEA.y) * ART_SCALE - lift;
  return `<i style="left:${at}px;top:${top}px;width:${width * ART_SCALE}px;height:${height * ART_SCALE}px;
    background-position:${-x * ART_SCALE}px ${-y * ART_SCALE}px"></i>`;
}

/** One slide: its part of the scene, the headline in a chat bubble, and the whole phone. */
function slideHtml(slide: (typeof SLIDES)[number], index: number, screen: string): string {
  const artWidth = 2808 * ART_SCALE;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Gabarito; src: url(${font("gabarito-latin-wght-normal.woff2")}); font-weight: 400 900; }
* { margin: 0; box-sizing: border-box; }
body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; background: #ffc917; }
.scene { position: absolute; top: 0; left: ${-index * WIDTH}px; width: ${SLIDES.length * WIDTH}px; height: ${HEIGHT}px; }
.sea { position: absolute; left: 0; top: ${HORIZON}px; image-rendering: pixelated; }
i { position: absolute; background: url(${ART}) no-repeat; background-size: ${artWidth}px auto; image-rendering: pixelated; }
.bubble { position: absolute; top: 150px; left: 50%; transform: translateX(-50%); width: max-content;
  max-width: 1250px; padding: 50px 56px 56px; text-align: center; border-radius: 72px 72px 72px 18px; background: #fff; box-shadow: 0 24px 60px rgba(11, 34, 57, .16);
  font: 800 104px/1.04 Gabarito, sans-serif; letter-spacing: -2px; color: #0b2239; }
.bubble span { display: block; color: #e5352b; }
.phone { position: absolute; top: 700px; left: 50%; width: 920px; transform: translateX(-50%);
  border-radius: 118px; overflow: hidden; box-shadow: 0 0 0 16px #0b2239, 0 50px 100px rgba(11, 34, 57, .45); }
.phone img { display: block; width: 100%; }
</style></head><body>
<div class="scene"><canvas class="sea" width="${SLIDES.length * WIDTH}" height="${HEIGHT - HORIZON}"></canvas>${SPRITES.map(sprite).join("")}</div>
<div class="bubble">${slide.headline}<span>${slide.accent}</span></div>
<div class="phone"><img src="data:image/png;base64,${screen}"></div>
<script>
// The sea repeats only its clean strip of the art, so no boat from the art shows twice. The block
// keeps the names local, because the page keeps its script scope from one slide to the next.
{
const art = new Image();
art.onload = () => {
  const canvas = document.querySelector(".sea");
  const pen = canvas.getContext("2d");
  pen.imageSmoothingEnabled = false;
  pen.fillStyle = "#0f47b4";
  pen.fillRect(0, 0, canvas.width, canvas.height);
  const width = ${SEA.width * ART_SCALE};
  for (let x = 0; x < canvas.width; x += width) {
    pen.drawImage(art, ${SEA.x}, ${SEA.y}, ${SEA.width}, ${SEA.height}, x, 0, width, ${SEA.height * ART_SCALE});
  }
  document.body.dataset.ready = "yes";
};
art.src = "${ART}";
}
</script>
</body></html>`;
}

async function compose() {
  mkdirSync(COMPOSED, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on("pageerror", (error) => console.error(error.message));
  for (const [index, slide] of SLIDES.entries()) {
    const screen = asBase64(join(RAW, `${slide.name}.png`));
    await page.setContent(slideHtml(slide, index, screen));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.body.dataset.ready === "yes");
    await page.screenshot({ path: join(COMPOSED, `${slide.name}.png`) });
  }
  await browser.close();
  console.log(`Composed screenshots in ${COMPOSED}`);
}

if (positionals[0] === "capture") capture();
else if (positionals[0] === "compose") await compose();
else {
  console.log(
    "Usage: node apps/mobile/scripts/store-screenshots.ts capture --app <path> | compose",
  );
  process.exitCode = 1;
}
