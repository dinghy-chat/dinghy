/** @jsxImportSource preact */
// The chat's panel, as pieces that hold no state of their own. The chat puts them together, and so
// does the operator app's preview of the Widget tab, so both show the same widget.
import { type ComponentChildren, Fragment, h, type RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { BOAT_CSS, type BoatKind, boatSvg } from "./boat.ts";
import type { ChatMessage } from "./client.ts";
import { IMAGE_TYPES, isComposing } from "./compose.ts";
import { EMOJIS, insertEmoji, SMILEY_ICON } from "./emoji.ts";
import { renderMarkdown } from "./markdown.ts";
import { type Quote, quoteStandIn } from "./quote.ts";
import { FAR, MIDDLE, NEAR, type SeaOptions, startSea } from "./sea.ts";
import {
  DEFAULT_COLORS,
  MESSAGE_MAX,
  type SavedAppearance,
  type TeamFace,
  type WidgetSettings,
} from "./shared.ts";
import { type TextId, t } from "./text.ts";

/**
 * The panel's colors at night, for a dark theme and for auto on a dark device. A site's own main
 * color stays, and the default one turns lighter, so the visitor's messages stand out.
 */
const DARK =
  "color-scheme:dark;--primary:var(--d-primary,#24456e);--paper:#14263b;--ink:#e8eef5;--fog:#1d3350;--sand:#0e1d2f;--line:#253a55;--mute:#9db0c6;--bad:#ff8077";

const { primary: PRIMARY, accent: ACCENT } = DEFAULT_COLORS;

// The panel paints the head color behind its top 40px, under the head, so the rounded corners show
// no white edge where the browser blends the panel with the head it clips.
export const CSS = `
*{box-sizing:border-box}
.panel{--primary:var(--d-primary,${PRIMARY});--paper:#fff;--ink:#0b2239;--fog:#f1f3f6;--sand:#faf8f2;--line:#e6e8ec;--mute:#5f6e80;--bad:#c62a21;position:absolute;right:0;bottom:0;display:flex;flex-direction:column;width:370px;max-width:calc(100vw - var(--d-x,16px) - 16px);height:560px;max-height:calc(100vh - var(--d-y,16px) - 16px);background:linear-gradient(var(--primary) 0 40px,var(--paper) 40px);color:var(--ink);font:14.5px/21px var(--dinghy-font,system-ui,-apple-system,Segoe UI,Roboto,sans-serif);border-radius:var(--dinghy-radius,var(--d-radius,16px));overflow:hidden;box-shadow:0 2px 6px rgb(13 34 64/.08),0 24px 56px rgb(13 34 64/.22)}
.head{display:flex;align-items:center;gap:8px;padding:10px 8px 10px 14px;background:var(--primary);color:var(--d-primary-text,#fff)}
.scene{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.scene>div{min-width:0}
.scene b,.scene small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.scene b{font-size:15px;font-weight:650;line-height:20px}
.scene small{font-size:12.5px;line-height:17px;opacity:.8}
.scene small::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:currentColor;opacity:.55;vertical-align:1px}
.on small::before{background:#2fd08a;opacity:1}
.sea,.port{position:relative;flex:none;width:36px;height:36px;overflow:hidden;background:#ffc917;border-radius:50%}
.logo{flex:none;width:36px;height:36px;border-radius:10px;object-fit:contain;background:#fff}
.sea canvas,.port canvas{position:absolute;left:0;top:0;width:100%;height:100%}
.float{position:absolute;left:0;top:0;z-index:1;transform-origin:50% 88%}
.sea-front{z-index:2}
.ship,.hull{display:block;animation:bob 3.4s ease-in-out infinite}
.ship svg,.hull svg{display:block}
.parcel{position:absolute;left:8px;top:14px;z-index:3;width:7px;height:6px;border-radius:1.5px;background:#fff;animation:send 1.2s ease-out infinite}
.moon{position:absolute;right:7px;top:6px;width:9px;height:9px;border-radius:50%;background:#fff8df}
.away .ship,.empty-state .ship{animation-duration:4.8s}
.lost .ship{transform-origin:50% 85%;animation:rock 1s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-2px) rotate(-2deg)}}
@keyframes rock{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}
@keyframes send{from{transform:translate(0,0);opacity:1}to{transform:translate(24px,-10px);opacity:0}}
@media (prefers-reduced-motion:reduce){.ship,.lost .ship,.parcel,.hull{animation:none}}
.log{flex:1;display:flex;flex-direction:column;gap:7px;padding:16px;overflow-y:auto;background:var(--sand)}
.empty{margin:auto 0;display:grid;justify-items:center;gap:12px;color:var(--mute);text-align:center}
.empty p{margin:0}
.port{width:150px;height:100px;border-radius:26px}
.sun{position:absolute;left:calc(78% - 12px);top:34px;width:24px;height:24px;border-radius:50%;background:#fff8df;box-shadow:0 0 0 5px rgb(255 248 223/.4)}
.msg{align-self:flex-start;max-width:84%;padding:9px 13px;border-radius:18px 18px 18px 5px;background:var(--paper);box-shadow:0 1px 2px rgb(13 34 64/.08);overflow-wrap:anywhere;white-space:pre-wrap}
.msg p,.msg ul,.msg ol,.msg pre,.msg blockquote{margin:0}.msg blockquote{padding:6px 10px;border-radius:10px;background:rgb(127 127 127/.14)}.msg>*+*{margin-top:10px}.msg ul,.msg ol{padding-left:20px}
.msg pre,.msg code{font:13px/1.4 ui-monospace,monospace}.msg code{padding:0 3px;border-radius:4px;background:rgb(127 127 127/.18)}.msg pre code{display:block;padding:6px 8px;overflow-x:auto}.msg a{color:inherit}
.mine{align-self:flex-end;border-radius:18px 18px 5px 18px;background:var(--primary);color:var(--d-primary-text,#fff);box-shadow:none}
.note{align-self:center;margin:6px 0;font-size:12px;line-height:16px;color:var(--mute);text-align:center}
.state{font-size:12.5px;line-height:16px;color:var(--mute);align-self:flex-end}
.bad{color:var(--bad)}
.action{display:grid;place-items:center;font:inherit;font-weight:600;flex:none;min-height:44px;min-width:44px;padding:0 14px;border:0;border-radius:22px;cursor:pointer;background:var(--d-accent,${ACCENT});color:var(--d-accent-text,#fff)}
.action:hover{filter:brightness(.92)}
.duo{fill:var(--d-accent,${ACCENT});opacity:.3}
.x{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:none;color:inherit;cursor:pointer;opacity:.85}
.x:hover{opacity:1;background:rgb(255 255 255/.16)}
.retry{font:inherit;border:0;padding:0;background:transparent;cursor:pointer;color:var(--bad);font-size:12.5px;line-height:16px;text-decoration:underline;align-self:flex-end}
button:focus-visible{outline:2px solid var(--d-accent,${ACCENT});outline-offset:1px}
input:focus-visible{outline:2px solid #1f6bff;outline-offset:-1px}
.head button:focus-visible{outline-color:currentColor}
form{display:flex;align-items:flex-end;gap:10px;padding:10px 12px 12px;border-top:1px solid var(--line)}
input{flex:1;min-width:0;font:inherit;color:inherit;background:var(--fog);border:1px solid transparent;border-radius:22px;padding:11px 16px}
.compose{display:block;padding:8px 12px;border:0}
.box{display:flex;align-items:flex-end;gap:4px;padding:5px;border:1px solid var(--line);border-radius:14px;background:var(--paper);box-shadow:0 1px 2px rgb(13 34 64/.05)}
.box:focus-within{border-color:var(--d-accent,${ACCENT});box-shadow:0 0 0 3px color-mix(in srgb,var(--d-accent,${ACCENT}) 22%,transparent)}
textarea{flex:1;min-width:0;max-height:117px;margin:0 2px;padding:5px 0;font:inherit;color:inherit;background:none;border:0;outline:0;resize:none}
.tool{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:0;border:0;border-radius:9px;background:none;color:var(--mute);cursor:pointer}
.tool:hover{background:var(--fog);color:var(--ink)}
.tool .duo{fill:currentColor;opacity:.2}
.send.on{background:var(--d-accent,${ACCENT});color:var(--d-accent-text,#fff)}
.send.on:hover{filter:brightness(.92)}
.msg{position:relative}
.re{position:absolute;left:100%;top:50%;margin:-16px 0 0 2px;opacity:0}
.msg:hover .re,.re:focus-visible{opacity:1}
@media (hover:none){.re{opacity:.7}}
.quote{display:block;margin:0 0 6px;padding:5px 9px;border-radius:10px;background:var(--fog);font-size:13px;white-space:pre-line}
.mine .quote{background:rgb(255 255 255/.18)}
.panel ::selection{background:var(--primary);color:var(--d-primary-text,#fff)}
.mine::selection,.mine ::selection{background:var(--d-primary-text,#fff);color:var(--primary)}
.quote b{display:block;font-size:12px}
.chip{display:flex;align-items:center;gap:4px;margin-bottom:6px}
.chip .quote{flex:1;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.shot{flex:none;max-width:84%;padding:0;border:0;border-radius:18px;overflow:hidden;background:var(--paper);align-self:flex-start;cursor:zoom-in}
.shot.mine{align-self:flex-end}
.shot img{display:block;max-width:100%;height:auto}
dialog{max-width:none;max-height:none;padding:0;border:0;background:transparent;overflow:hidden}
dialog::backdrop{background:rgb(11 34 57/.85)}
dialog img{display:block;max-width:95vw;max-height:95svh}
.panel.page{inset:0;margin:auto;width:100%;max-width:720px;height:auto;max-height:none;border-radius:0}
@media (max-width:480px){.panel:not(.page){position:fixed;inset:0;width:100%;max-width:none;height:100%;height:100dvh;max-height:none;border-radius:0}textarea,input{font-size:16px}.panel:not(.page) .head{padding-top:max(10px,env(safe-area-inset-top))}.panel:not(.page)>:last-child{padding-bottom:max(12px,env(safe-area-inset-bottom))}}
.panel:focus{outline:none}
:host([data-side=left]) .panel{right:auto;left:0}
.opened{display:none!important}
.badge{position:absolute;top:-3px;right:-3px;min-width:22px;height:22px;padding:0 4px;box-sizing:border-box;border-radius:11px;background:#e5352b;color:#fff;box-shadow:0 0 0 2px #fff;font:700 12px/22px system-ui,sans-serif;text-align:center}
.panel.drop{outline:3px dashed var(--d-accent,${ACCENT});outline-offset:-6px}
.compose{position:relative}
.emojis{position:absolute;left:8px;right:8px;bottom:100%;margin:0;min-width:0;display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:6px;background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 24px rgb(13 34 64/.18)}
.emojis button{height:36px;padding:0;border:0;border-radius:8px;background:none;font-size:20px;cursor:pointer}
.emojis button:hover{background:var(--fog)}
.file{position:absolute;width:1px;height:1px;padding:0;border:0;opacity:0;overflow:hidden;pointer-events:none}
.card{display:block;align-self:stretch;margin:6px 0;padding:12px 14px;border:0;border-radius:16px;background:color-mix(in srgb,var(--primary) 7%,var(--paper));box-shadow:0 1px 2px rgb(13 34 64/.08)}
.card .who{margin:0;color:var(--ink);font-weight:600}
.card p{margin:4px 0 0;font-size:13px;line-height:18px;color:var(--mute)}
.card .bad{color:var(--bad)}
.card .face svg{width:18px;height:auto}
.row{display:flex;gap:8px;margin-top:10px}
.card input{padding:9px 14px;background:var(--paper);border-color:var(--line)}
.notice{padding:7px 16px;font-size:12.5px;line-height:16px;color:var(--mute);border-top:1px solid var(--line)}
.notice.bad{color:var(--bad)}
.who{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12.5px;line-height:16px;color:var(--mute)}
.face{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;object-fit:cover;background:var(--fog);color:var(--mute);font-size:11px;font-weight:700}
.faces{display:flex;flex:none;padding-left:6px}
.faces .face{width:26px;height:26px;margin-left:-6px;box-shadow:0 0 0 2px var(--primary)}
.faces>span{position:relative;display:flex}
.faces i{position:absolute;z-index:1;right:-1px;bottom:-1px;width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px var(--primary)}
.brand{display:block;padding:0 12px 8px;font-size:11px;line-height:14px;color:var(--mute);opacity:.75;text-align:center;text-decoration:none}
.brand:hover{opacity:1}
:host([data-theme=dark]) .panel{${DARK}}
@media (prefers-color-scheme:dark){:host([data-theme=auto]) .panel{${DARK}}}
${BOAT_CSS}
`;

/** A Phosphor Icons (MIT) duotone path pair: the light layer, then the main one. */
type Paths = [string, string];

/** A duotone icon. The CSS colors the light layer. */
function Icon({ paths: [light, main], size = 20 }: { paths: Paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path class="duo" d={light} />
      <path d={main} />
    </svg>
  );
}

/** The light layer of the round icons. */
const CIRCLE = "M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z";

const ATTACH_ICON: Paths = [
  "M180.75,104.75,204,128l-82.06,81.94a48,48,0,0,1-67.88-67.88L153.37,41.37a32,32,0,0,1,45.26,45.26Z",
  "M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z",
];
/** A robot, for a reply from an API key. Drawn for this widget. */
const BOT_ICON =
  "M11 2h2v3h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5zM9 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM1 10h2v5H1zm20 0h2v5h-2z";
/** A curved arrow back, for Reply. Drawn for this widget. */
const REPLY_ICON: Paths = ["", "M112 56 24 128l88 72v-48c56 0 96 16 120 56-8-72-48-120-120-128z"];
const SEND_ICON: Paths = [
  "M227.91,134.86,59.93,231a8,8,0,0,1-11.44-9.67L80,128,48.49,34.72a8,8,0,0,1,11.44-9.67l168,95.85A8,8,0,0,1,227.91,134.86Z",
  "M231.87,114l-168-95.89A16,16,0,0,0,40.92,37.34L71.55,128,40.92,218.67A16,16,0,0,0,56,240a16.15,16.15,0,0,0,7.93-2.1l167.92-96.05a16,16,0,0,0,.05-27.89ZM56,224a.56.56,0,0,0,0-.12L85.74,136H144a8,8,0,0,0,0-16H85.74L56.06,32.16A.46.46,0,0,0,56,32l168,95.83Z",
];

/** Who sent a reply, as the widget shows it. Its ID is the server's hash of the author's. */
interface Author extends TeamFace {
  bot: boolean;
}

export interface Line {
  id: string;
  /** Null until the server confirms it. Confirmed lines sort by this, and pending ones go last. */
  seq: bigint | null;
  body: string;
  image: ChatMessage["image"];
  /** Held until the server confirms it, so a retry can send it again. */
  file?: File;
  fromVisitor: boolean;
  /** Null for the visitor's own message. */
  author: Author | null;
  /** A status line: the conversation was closed, or reopened by the team or by a message. */
  note?: "closed" | "reopened";
  status: "sent" | "sending" | "failed";
  quote?: Quote | null;
  /** Deleted by the team: its body is the placeholder, and it cannot be quoted. */
  gone?: boolean;
}

export type SceneState = "waiting" | "sending" | "reply" | "away" | "lost" | "empty";

/** Each state has text, so it means the same with mascot: false and with no animation. */
const SCENES: Record<SceneState, { boat: BoatKind; text: TextId }> = {
  waiting: { boat: "sail", text: "waiting" },
  sending: { boat: "sail", text: "sceneSending" },
  reply: { boat: "flag", text: "newReply" },
  away: { boat: "sail", text: "teamAway" },
  lost: { boat: "sail", text: "reconnecting" },
  // The greeting shows in the chat itself, so the header keeps to one short line.
  empty: { boat: "sail", text: "waiting" },
};

// The landing page's three swells, in the header's round window and in the empty chat.
const HEAD_SEA: SeaOptions = {
  layers: [
    { level: 0.6, swell: 1, ...FAR },
    { level: 0.75, swell: 1.2, ...MIDDLE },
    { level: 0.9, swell: 1.2, ...NEAR },
  ],
  boatLayer: 1,
  boatAt: 0.5,
  drift: 2,
};
const PORT_SEA: SeaOptions = {
  layers: [
    { level: 0.56, swell: 1.8, ...FAR },
    { level: 0.72, swell: 2, ...MIDDLE },
    { level: 0.88, swell: 2, ...NEAR },
  ],
  boatLayer: 1,
  boatAt: 0.42,
  drift: 6,
  sunAt: 0.78,
};

/** A boat on moving swell. The text beside it says the same. */
function Sea(props: {
  class: string;
  options: SeaOptions;
  boat: string;
  boatClass: string;
  children?: ComponentChildren;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(
    () => (host.current ? startSea(host.current, props.options) : undefined),
    [props.options],
  );
  return (
    <div class={props.class} ref={host} aria-hidden="true">
      {props.children}
      <canvas class="sea-back" />
      <span class="float">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from boat.ts. */}
        <span class={props.boatClass} dangerouslySetInnerHTML={{ __html: props.boat }} />
      </span>
      <canvas class="sea-front" />
    </div>
  );
}

/** The workspace's own words where it set them, and Dinghy's text everywhere else. */
type Say = (id: TextId) => string;

const OWN_TEXTS: Partial<Record<TextId, "title" | "greeting" | "away">> = {
  title: "title",
  empty: "greeting",
  teamAway: "away",
};

/** The texts of a workspace's saved settings. */
export const sayer =
  (saved: SavedAppearance): Say =>
  (id) => {
    const own = OWN_TEXTS[id];
    return own === undefined ? t(id) : (saved[own] ?? t(id));
  };

/** Whether this line is a reply that follows the visitor or another author, so it names who. */
export function startsRun(lines: Line[], index: number): boolean {
  const author = lines[index]?.author ?? null;
  const before = lines[index - 1]?.author ?? null;
  return author !== null && author.id !== before?.id;
}

/** Whether the panel shows the email form and the message box. */
export interface EmailLayout {
  form: boolean;
  composer: boolean;
}

/**
 * The email rule that the chat and the preview share. `mayAsk` is false once the email is saved,
 * for a visitor the site signed in, and on a server that sends no email. `known` is false while
 * the server has not said whether it holds the visitor's email.
 */
export function emailLayout(
  ask: WidgetSettings["emailAsk"],
  { mayAsk, chatted, known }: { mayAsk: boolean; chatted: boolean; known: boolean },
): EmailLayout {
  if (!mayAsk) return { form: false, composer: true };
  if (ask === "before_first") {
    // A visitor who chatted before the setting changed is not stopped now.
    if (chatted) return { form: false, composer: true };
    // Neither shows until the server answers, so nobody writes before giving an email.
    return { form: known, composer: false };
  }
  // After the first message, so it takes no space from someone who is only looking.
  return { form: ask === "after_first" && chatted, composer: true };
}

/** A person's picture, a bot's icon, or an initial. */
function Face({ name, pictureUrl, bot = false }: TeamFace & { bot?: boolean }) {
  if (pictureUrl !== null) return <img class="face" src={pictureUrl} alt="" />;
  return (
    <span class="face">
      {bot ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d={BOT_ICON} />
        </svg>
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

/**
 * The header's faces as the owner chose them. Online now shows the members online, in order, and
 * the latest repliers when nobody is. Every other mode shows its candidates.
 */
export function headerFaces(saved: SavedAppearance, members: string[]): TeamFace[] {
  const { headerFaces: mode, faces } = saved;
  const here = faces.filter((face) => members.includes(face.id));
  const shown = mode !== "online" ? faces : here.length > 0 ? here : saved.team;
  return shown.slice(0, saved.headerFaceCount);
}

/** "Usually replies in 2 min", or in hours from an hour. */
function replyTime(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes < 60
    ? t("replyMinutes").replace("{n}", `${minutes}`)
    : t("replyHours").replace("{n}", `${Math.round(minutes / 60)}`);
}

/**
 * The panel's title bar: the workspace's logo or the boat's scene, what the scene means in words,
 * the team's faces and the close button.
 */
export function ChatHead({
  scene,
  online,
  members,
  replySeconds,
  mascot,
  saved,
  say,
  onClose,
}: {
  scene: SceneState;
  online: boolean | null;
  /** The members online now, by the hash on their faces. */
  members: string[];
  /** The usual first reply time, from the presence answer. */
  replySeconds: number | null;
  mascot: boolean;
  saved: SavedAppearance;
  say: Say;
  /** Missing on the full-page chat, which has nothing to close. */
  onClose?: () => void;
}) {
  const { logoUrl } = saved;
  const isOnline = scene === "waiting" && online === true;
  const status =
    isOnline && saved.headerStatus === "reply_time" && replySeconds !== null
      ? replyTime(replySeconds)
      : say(isOnline ? "teamOnline" : SCENES[scene].text);
  const faces = headerFaces(saved, members);
  return (
    <div class="head">
      <div class={`scene ${scene === "empty" ? "empty-state" : scene}${isOnline ? " on" : ""}`}>
        {/* The title beside it names the company, so the logo needs no text of its own. */}
        {logoUrl !== null ? (
          <img class="logo" src={logoUrl} alt="" />
        ) : (
          mascot && (
            <Sea
              class="sea"
              options={HEAD_SEA}
              boat={boatSvg(SCENES[scene].boat, 26)}
              boatClass="ship"
            >
              {scene === "away" && <i class="moon" />}
              {scene === "sending" && <i class="parcel" />}
            </Sea>
          )
        )}
        <div>
          <b>{say("title")}</b>
          {/* An owner's own away text can be long, so the whole of it is in the title. */}
          <small role="status" title={status}>
            {status}
          </small>
        </div>
      </div>
      {/* The status line says whether anyone is online, so the faces and dots have no text. */}
      {faces.length > 0 && (
        <span class="faces" aria-hidden="true">
          {faces.map((face) => (
            <span key={face.id}>
              <Face {...face} />
              {saved.headerDot && members.includes(face.id) && <i />}
            </span>
          ))}
        </span>
      )}
      {onClose !== undefined && (
        <button type="button" class="x" aria-label={t("close")} onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M18 6 6 18M6 6l12 12"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A quoted message: who wrote it, and its whole text. */
function Quoted({ quote }: { quote: Quote }) {
  const standIn = quoteStandIn(quote);
  return (
    <span class="quote">
      <b>{quote.fromVisitor ? t("you") : quote.authorName}</b>
      {standIn ? t(standIn) : quote.text}
    </span>
  );
}

/**
 * One message in the log, with its sending state or a retry button. The first reply of a run shows
 * who sent it.
 */
export function ChatLine({
  line,
  showAuthor,
  onView,
  onImageError,
  onRetry,
  onReply,
}: {
  line: Line;
  showAuthor: boolean;
  onView(): void;
  onImageError(): void;
  onRetry(): void;
  /** Only on the team's messages: quotes this one in the next message. */
  onReply?: (() => void) | undefined;
}) {
  if (line.note !== undefined) return <p class="note">{t(line.note)}</p>;
  return (
    <Fragment>
      {showAuthor && line.author !== null && (
        <div class="who">
          <Face {...line.author} />
          {line.author.name}
        </div>
      )}
      {line.image !== null ? (
        <button
          type="button"
          class={line.fromVisitor ? "shot mine" : "shot"}
          aria-label={t("imageView")}
          onClick={onView}
        >
          <img
            src={line.image.url}
            width={line.image.width}
            height={line.image.height}
            alt={t("imageAlt")}
            loading="lazy"
            onError={onImageError}
          />
        </button>
      ) : line.file !== undefined ? (
        <div class="msg mine">{t("imageSending")}</div>
      ) : (
        <div class={line.fromVisitor ? "msg mine" : "msg"}>
          {line.quote && <Quoted quote={line.quote} />}
          {renderMarkdown(line.body, h)}
          {onReply && (
            <button type="button" class="tool re" aria-label={t("reply")} onClick={onReply}>
              <Icon paths={REPLY_ICON} size={16} />
            </button>
          )}
        </div>
      )}
      {line.status === "sending" && <div class="state">{t("sending")}</div>}
      {line.status === "failed" && (
        <button type="button" class="retry" onClick={onRetry}>
          {t("failed")}
        </button>
      )}
    </Fragment>
  );
}

/** An empty chat: the boat in port, and the greeting. */
export function EmptyLog({ mascot, greeting }: { mascot: boolean; greeting: string }) {
  return (
    <div class="empty">
      {mascot && (
        <Sea class="port" options={PORT_SEA} boat={boatSvg("sail", 64)} boatClass="hull">
          <i class="sun" />
        </Sea>
      )}
      <p>{greeting}</p>
    </div>
  );
}

/**
 * Asks a signed-out visitor for an email, so a reply can reach them after they leave. A card from
 * the team, never a second message box: in the conversation after the first message, or alone
 * before it.
 */
export function EmailCard({
  face,
  lead,
  email,
  bad,
  onInput,
  onSubmit,
}: {
  /** The team member the card comes from, or null for the boat. */
  face: TeamFace | null;
  lead: TextId;
  email: string;
  /** Why the last save failed, or null. */
  bad: TextId | null;
  onInput(email: string): void;
  onSubmit(event: Event): void;
}) {
  return (
    <form class="card" aria-label={t("emailTitle")} onSubmit={onSubmit}>
      <b class="who">
        {face === null ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from boat.ts.
          <span class="face" dangerouslySetInnerHTML={{ __html: boatSvg("sail", 18) }} />
        ) : (
          <Face {...face} />
        )}
        {t("emailTitle")}
      </b>
      <p>{t(lead)}</p>
      <div class="row">
        <input
          type="email"
          autocomplete="email"
          aria-label={t("emailLabel")}
          placeholder={t("emailPlaceholder")}
          required
          value={email}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
        <button type="submit" class="action">
          {t("emailSave")}
        </button>
      </div>
      {bad !== null && (
        <p class="bad" role="alert">
          {t(bad)}
        </p>
      )}
    </form>
  );
}

/** Where the email card stood once the email is saved: one quiet line with the address. */
export function EmailSaved({ email }: { email: string }) {
  const [before, after] = t("emailSavedTo").split("{email}");
  return (
    <p class="note" role="status">
      {before}
      <b>{email}</b>
      {after}
    </p>
  );
}

/** The message box, with its image picker and its send button. */
export function Composer({
  draft,
  inputRef,
  onDraft,
  onSubmit,
  onFiles,
  quoting,
  onUnquote,
}: {
  draft: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onDraft(draft: string): void;
  onSubmit(event: Event): void;
  onFiles(files: Iterable<File>): void;
  /** The quote of the team's message that the next one quotes. */
  quoting?: Quote | null;
  onUnquote?: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [emojis, setEmojis] = useState(false);
  // The box grows with the text, up to its CSS max-height, and shrinks again after a send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new draft asks for a new height.
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (field === null) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [draft, inputRef]);
  return (
    <form class="compose" onSubmit={onSubmit}>
      {emojis && (
        <fieldset
          class="emojis"
          aria-label={t("emoji")}
          onKeyDown={(event) => event.key === "Escape" && setEmojis(false)}
        >
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                const field = inputRef.current;
                if (field !== null) onDraft(insertEmoji(field, emoji));
                setEmojis(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      )}
      <input
        ref={picker}
        class="file"
        type="file"
        multiple
        accept={IMAGE_TYPES.join(",")}
        aria-label={t("attach")}
        tabIndex={-1}
        onChange={(event) => {
          onFiles(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
        }}
      />
      {quoting && (
        <div class="chip">
          <Quoted quote={quoting} />
          <button type="button" class="tool" aria-label={t("cancelReply")} onClick={onUnquote}>
            ×
          </button>
        </div>
      )}
      <div class="box">
        <button
          type="button"
          class="tool"
          aria-label={t("attach")}
          onClick={() => picker.current?.click()}
        >
          <Icon paths={ATTACH_ICON} />
        </button>
        <button
          type="button"
          class="tool"
          aria-label={t("emoji")}
          aria-expanded={emojis}
          onClick={() => setEmojis(!emojis)}
        >
          <Icon paths={[CIRCLE, SMILEY_ICON]} />
        </button>
        <textarea
          rows={1}
          onPaste={(event) => {
            // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
            const data = event.clipboardData;
            if (data === null || data.files.length === 0 || data.getData("text/plain") !== "")
              return;
            event.preventDefault();
            onFiles(data.files);
          }}
          ref={inputRef}
          aria-label={t("inputLabel")}
          placeholder={t("inputPlaceholder")}
          maxLength={MESSAGE_MAX}
          value={draft}
          onInput={(event) => onDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing(event)) onSubmit(event);
            // The first Escape drops the quote, and the next one closes the chat.
            if (event.key === "Escape" && quoting) {
              event.stopPropagation();
              onUnquote?.();
            }
          }}
        />
        <button
          type="submit"
          class={draft.trim() === "" ? "tool send" : "tool send on"}
          aria-label={t("send")}
        >
          <Icon paths={SEND_ICON} size={18} />
        </button>
      </div>
    </form>
  );
}

/** The muted line under the chat, a plain link with no tracking. */
export function Branding() {
  return (
    <a class="brand" href="https://dinghy.chat" target="_blank" rel="noopener">
      {t("poweredBy")}
    </a>
  );
}
