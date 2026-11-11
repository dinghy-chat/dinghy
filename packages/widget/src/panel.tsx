/** @jsxImportSource preact */
// The chat's panel, as pieces that hold no state of their own. The chat puts them together, and so
// does the operator app's preview of the Widget tab, so both show the same widget.
import { type ComponentChildren, Fragment, type RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { BOAT_CSS, type BoatKind, boatSvg } from "./boat.ts";
import type { ChatMessage } from "./client.ts";
import { IMAGE_TYPES, isComposing } from "./compose.ts";
import { FAR, MIDDLE, NEAR, type SeaOptions, startSea } from "./sea.ts";
import type { Saved, TeamFace } from "./shared.ts";
import { type TextId, t } from "./text.ts";

/** The composer's limit, which the server shares. */
export const MESSAGE_MAX = 10_000;

/**
 * The panel's colors at night, for a dark theme and for auto on a dark device. A site's own main
 * color stays, and the default one turns lighter, so the visitor's messages stand out.
 */
const DARK =
  "color-scheme:dark;--primary:var(--d-primary,#24456e);--paper:#14263b;--ink:#e8eef5;--fog:#1d3350;--sand:#0e1d2f;--line:#253a55;--mute:#9db0c6;--bad:#ff8077";

export const CSS = `
*{box-sizing:border-box}
.panel{--primary:var(--d-primary,#0b2239);--paper:#fff;--ink:#0b2239;--fog:#f1f3f6;--sand:#faf8f2;--line:#e6e8ec;--mute:#5f6e80;--bad:#c62a21;position:absolute;right:0;bottom:0;display:flex;flex-direction:column;width:370px;max-width:calc(100vw - var(--d-x,16px) - 16px);height:560px;max-height:calc(100vh - var(--d-y,16px) - 16px);background:var(--paper);color:var(--ink);font:14.5px/21px var(--dinghy-font,system-ui,-apple-system,Segoe UI,Roboto,sans-serif);border-radius:var(--dinghy-radius,var(--d-radius,16px));overflow:hidden;box-shadow:0 2px 6px rgb(13 34 64/.08),0 24px 56px rgb(13 34 64/.22)}
.head{display:flex;align-items:center;gap:8px;padding:16px 10px 16px 16px;background:var(--primary);color:var(--d-primary-text,#fff)}
.scene{flex:1;min-width:0;display:flex;align-items:center;gap:12px}
.scene b{display:block;min-height:21px;font-size:17px;font-weight:700;line-height:21px;letter-spacing:-.01em}
.scene small{display:block;font-size:13px;line-height:17px;opacity:.85}
.waiting small::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:#2fd08a;vertical-align:1px}
.sea,.port{position:relative;flex:none;width:46px;height:46px;overflow:hidden;background:#ffc917;border-radius:50%}
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
.mine{align-self:flex-end;border-radius:18px 18px 5px 18px;background:var(--primary);color:var(--d-primary-text,#fff);box-shadow:none}
.state{font-size:12.5px;line-height:16px;color:var(--mute);align-self:flex-end}
.bad{color:var(--bad)}
.action{display:grid;place-items:center;font:inherit;font-weight:600;flex:none;min-height:44px;min-width:44px;padding:0 14px;border:0;border-radius:22px;cursor:pointer;background:var(--d-accent,#e5352b);color:var(--d-accent-text,#fff)}
.action:hover{filter:brightness(.92)}
.duo{fill:var(--d-accent,#e5352b);opacity:.3}
.head .duo{fill:#ffc917;opacity:.45}
.head .icon .duo{fill:currentColor;opacity:.25}
[type=submit] .duo{fill:#ffc917;opacity:1}
.icon{background:transparent;color:inherit;padding:0}
.icon:hover{filter:none;background:rgb(127 127 127/.25)}
.retry{font:inherit;border:0;padding:0;background:transparent;cursor:pointer;color:var(--bad);font-size:12.5px;line-height:16px;text-decoration:underline;align-self:flex-end}
button:focus-visible{outline:2px solid var(--d-accent,#e5352b);outline-offset:1px}
textarea:focus-visible,input:focus-visible{outline:2px solid #1f6bff;outline-offset:-1px}
.head button:focus-visible{outline-color:currentColor}
form{display:flex;align-items:flex-end;gap:10px;padding:10px 12px 12px;border-top:1px solid var(--line)}
textarea,input{flex:1;min-width:0;font:inherit;color:inherit;background:var(--fog);border:1px solid transparent;border-radius:22px;padding:11px 16px}
textarea{resize:none;height:44px}
.shot{display:block;max-width:84%;padding:0;border:0;border-radius:18px;overflow:hidden;background:var(--paper);align-self:flex-start;cursor:zoom-in}
.shot.mine{align-self:flex-end}
.shot img{display:block;max-width:100%;height:auto}
dialog{padding:0;border:0;background:transparent;max-width:95vw;max-height:95vh;overflow:auto}
dialog::backdrop{background:rgb(11 34 57/.85)}
dialog img{display:block;max-width:none}
.panel.page{inset:0;margin:auto;width:100%;max-width:720px;height:auto;max-height:none;border-radius:0}
@media (max-width:480px){.panel:not(.page){position:fixed;inset:0;width:100%;max-width:none;height:100%;height:100dvh;max-height:none;border-radius:0}.panel:not(.page) .head{padding-top:max(16px,env(safe-area-inset-top))}.panel:not(.page)>:last-child{padding-bottom:max(12px,env(safe-area-inset-bottom))}}
.panel:focus{outline:none}
:host([data-side=left]) .panel{right:auto;left:0}
.opened{display:none!important}
.badge{position:absolute;top:-3px;right:-3px;min-width:22px;height:22px;padding:0 4px;box-sizing:border-box;border-radius:11px;background:#e5352b;color:#fff;box-shadow:0 0 0 2px #fff;font:700 12px/22px system-ui,sans-serif;text-align:center}
.panel.drop{outline:3px dashed var(--d-accent,#e5352b);outline-offset:-6px}
.pick{background:transparent;color:inherit;padding:0}
.pick:hover{filter:none;background:var(--fog)}
.file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.email{flex-wrap:wrap;align-items:center}
.email label{width:100%;font-size:12.5px;line-height:16px;color:var(--mute)}
.notice{padding:7px 16px;font-size:12.5px;line-height:16px;color:var(--mute);border-top:1px solid var(--line)}
.notice.bad{color:var(--bad)}
.who{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12.5px;line-height:16px;color:var(--mute)}
.face{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;object-fit:cover;background:var(--fog);color:var(--mute);font-size:11px;font-weight:700}
.faces{display:flex;flex:none;padding-left:8px}
.faces .face{width:28px;height:28px;margin-left:-8px;box-shadow:0 0 0 2px var(--primary)}
.brand{display:block;padding:0 12px 10px;font-size:11.5px;line-height:15px;color:var(--mute);text-align:center;text-decoration:none}
.brand:hover{text-decoration:underline}
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

const CLOSE_ICON: Paths = [
  "M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z",
  "M165.66,101.66,139.31,128l26.35,26.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
];
const ATTACH_ICON: Paths = [
  "M180.75,104.75,204,128l-82.06,81.94a48,48,0,0,1-67.88-67.88L153.37,41.37a32,32,0,0,1,45.26,45.26Z",
  "M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z",
];
/** A robot, for a reply from an API key. Drawn for this widget. */
const BOT_ICON =
  "M11 2h2v3h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5zM9 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM1 10h2v5H1zm20 0h2v5h-2z";
const SEND_ICON: Paths = [
  "M227.91,134.86,59.93,231a8,8,0,0,1-11.44-9.67L80,128,48.49,34.72a8,8,0,0,1,11.44-9.67l168,95.85A8,8,0,0,1,227.91,134.86Z",
  "M231.87,114l-168-95.89A16,16,0,0,0,40.92,37.34L71.55,128,40.92,218.67A16,16,0,0,0,56,240a16.15,16.15,0,0,0,7.93-2.1l167.92-96.05a16,16,0,0,0,.05-27.89ZM56,224a.56.56,0,0,0,0-.12L85.74,136H144a8,8,0,0,0,0-16H85.74L56.06,32.16A.46.46,0,0,0,56,32l168,95.83Z",
];

/** Who sent a reply, as the widget shows it. */
interface Author {
  name: string;
  pictureUrl: string | null;
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
  status: "sent" | "sending" | "failed";
}

export type SceneState = "waiting" | "sending" | "reply" | "away" | "lost" | "empty";

/** Each state has text, so it means the same with mascot: false and with no animation. */
const SCENES: Record<SceneState, { boat: BoatKind; text: TextId }> = {
  waiting: { boat: "sail", text: "waiting" },
  sending: { boat: "sail", text: "sceneSending" },
  reply: { boat: "flag", text: "newReply" },
  away: { boat: "sail", text: "teamAway" },
  lost: { boat: "sail", text: "reconnecting" },
  empty: { boat: "sail", text: "empty" },
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

/** Before the server answers, a text the workspace can set is empty rather than Dinghy's. */
export const sayer =
  (saved: Saved | undefined): Say =>
  (id) => {
    const own = OWN_TEXTS[id];
    if (own === undefined) return t(id);
    return saved === undefined ? "" : (saved[own] ?? t(id));
  };

/** Whether this line is a reply that follows the visitor or another author, so it names who. */
export function startsRun(lines: Line[], index: number): boolean {
  const author = lines[index]?.author ?? null;
  const before = lines[index - 1]?.author ?? null;
  return (
    author !== null &&
    (before === null || before.name !== author.name || before.pictureUrl !== author.pictureUrl)
  );
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
 * The panel's title bar: the workspace's logo or the boat's scene, what the scene means in words,
 * the team's faces and the close button.
 */
export function ChatHead({
  scene,
  online,
  mascot,
  logoUrl,
  team,
  say,
  onClose,
}: {
  scene: SceneState;
  online: boolean | null;
  mascot: boolean;
  logoUrl: string | null;
  /** Who is on the team, not who is online, so the faces have no text of their own. */
  team: TeamFace[];
  say: Say;
  /** Missing on the full-page chat, which has nothing to close. */
  onClose?: () => void;
}) {
  return (
    <div class="head">
      <div class={`scene ${scene === "empty" ? "empty-state" : scene}`}>
        {/* The title beside it names the company, so the logo needs no text of its own. */}
        {logoUrl !== null ? (
          <img class="logo" src={logoUrl} alt="" />
        ) : (
          mascot && (
            <Sea
              class="sea"
              options={HEAD_SEA}
              boat={boatSvg(SCENES[scene].boat, 32)}
              boatClass="ship"
            >
              {scene === "away" && <i class="moon" />}
              {scene === "sending" && <i class="parcel" />}
            </Sea>
          )
        )}
        <div>
          <b>{say("title")}</b>
          <small role="status">
            {say(scene === "waiting" && online === true ? "teamOnline" : SCENES[scene].text)}
          </small>
        </div>
      </div>
      {team.length > 0 && (
        <span class="faces" aria-hidden="true">
          {team.map((face) => (
            <Face key={face.name} {...face} />
          ))}
        </span>
      )}
      {onClose !== undefined && (
        <button type="button" class="action icon" aria-label={t("close")} onClick={onClose}>
          <Icon paths={CLOSE_ICON} size={24} />
        </button>
      )}
    </div>
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
}: {
  line: Line;
  showAuthor: boolean;
  onView(): void;
  onImageError(): void;
  onRetry(): void;
}) {
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
        <div class={line.fromVisitor ? "msg mine" : "msg"}>{line.body}</div>
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
export function EmptyLog({ mascot, greeting }: { mascot: boolean; greeting: string | null }) {
  return (
    <div class="empty">
      {mascot && (
        <Sea class="port" options={PORT_SEA} boat={boatSvg("sail", 64)} boatClass="hull">
          <i class="sun" />
        </Sea>
      )}
      {greeting !== null && <p>{greeting}</p>}
    </div>
  );
}

/** Asks a signed-out visitor for an email, so a reply can reach them after they leave. */
export function EmailForm({
  email,
  bad,
  onInput,
  onSubmit,
}: {
  email: string;
  /** Why the last save failed, or null. */
  bad: TextId | null;
  onInput(email: string): void;
  onSubmit(event: Event): void;
}) {
  return (
    <form class="email" onSubmit={onSubmit}>
      <label for="dinghy-email">
        {bad === null ? t("emailLabel") : <span class="bad">{t(bad)}</span>}
      </label>
      <input
        id="dinghy-email"
        type="email"
        autocomplete="email"
        required
        value={email}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
      <button type="submit" class="action">
        {t("emailSave")}
      </button>
    </form>
  );
}

/** The message box, with its image picker and its send button. */
export function Composer({
  draft,
  inputRef,
  onDraft,
  onSubmit,
  onFiles,
}: {
  draft: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onDraft(draft: string): void;
  onSubmit(event: Event): void;
  onFiles(files: Iterable<File>): void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <form onSubmit={onSubmit}>
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
      <button
        type="button"
        class="action pick"
        aria-label={t("attach")}
        onClick={() => picker.current?.click()}
      >
        <Icon paths={ATTACH_ICON} />
      </button>
      <textarea
        onPaste={(event) => {
          // A copy from Word or Excel holds its text and a picture of it. The text is what is meant.
          const data = event.clipboardData;
          if (data === null || data.files.length === 0 || data.getData("text/plain") !== "") return;
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
        }}
      />
      <button type="submit" class="action" aria-label={t("send")}>
        <Icon paths={SEND_ICON} size={18} />
      </button>
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
