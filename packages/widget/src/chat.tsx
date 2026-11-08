import { type ComponentChildren, Fragment, render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { BOAT_CSS, type BoatKind, boatSvg } from "./boat.ts";
import { ApiError, type ChatMessage, createClient } from "./client.ts";
import {
  IMAGE_TYPES,
  imageProblem,
  inCommitOrder,
  isComposing,
  newClientId,
  REFRESH_LIMIT_MS,
  REFUSED,
} from "./compose.ts";
import { FAR, MIDDLE, NEAR, type SeaOptions, startSea } from "./sea.ts";
import { readToken, type WidgetContext, writeToken } from "./shared.ts";
import { type TextId, t } from "./text.ts";

const CSS = `
*{box-sizing:border-box}
.panel{--fog:#f1f3f6;--sand:#faf8f2;--line:#e6e8ec;--mute:#5f6e80;--bad:#c62a21;position:absolute;right:0;bottom:0;display:flex;flex-direction:column;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 32px);background:#fff;color:#0b2239;font:14.5px/21px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border-radius:22px;overflow:hidden;box-shadow:0 2px 6px rgb(13 34 64/.08),0 24px 56px rgb(13 34 64/.22)}
.head{display:flex;align-items:center;gap:8px;padding:16px 10px 16px 16px;background:var(--d-primary,#0b2239);color:var(--d-primary-text,#fff)}
.scene{flex:1;min-width:0;display:flex;align-items:center;gap:12px}
.scene b{display:block;font-size:17px;font-weight:700;line-height:21px;letter-spacing:-.01em}
.scene small{display:block;font-size:13px;line-height:17px;opacity:.85}
.waiting small::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:#2fd08a;vertical-align:1px}
.sea,.port{position:relative;flex:none;width:46px;height:46px;overflow:hidden;background:#ffc917;border-radius:50%}
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
.msg{align-self:flex-start;max-width:84%;padding:9px 13px;border-radius:18px 18px 18px 5px;background:#fff;box-shadow:0 1px 2px rgb(13 34 64/.08);overflow-wrap:anywhere;white-space:pre-wrap}
.mine{align-self:flex-end;border-radius:18px 18px 5px 18px;background:var(--d-primary,#0b2239);color:var(--d-primary-text,#fff);box-shadow:none}
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
.shot{display:block;max-width:84%;padding:0;border:0;border-radius:18px;overflow:hidden;background:#fff;align-self:flex-start;cursor:zoom-in}
.shot.mine{align-self:flex-end}
.shot img{display:block;max-width:100%;height:auto}
dialog{padding:0;border:0;background:transparent;max-width:95vw;max-height:95vh;overflow:auto}
dialog::backdrop{background:rgb(11 34 57/.85)}
dialog img{display:block;max-width:none}
.panel:focus{outline:none}
.panel.drop{outline:3px dashed var(--d-accent,#e5352b);outline-offset:-6px}
.pick{background:transparent;color:inherit;padding:0}
.pick:hover{filter:none;background:var(--fog)}
.file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.email{flex-wrap:wrap;align-items:center}
.email label{width:100%;font-size:12.5px;line-height:16px;color:var(--mute)}
.notice{padding:7px 16px;font-size:12.5px;line-height:16px;color:var(--mute);border-top:1px solid var(--line)}
.notice.bad{color:var(--bad)}
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
const SEND_ICON: Paths = [
  "M227.91,134.86,59.93,231a8,8,0,0,1-11.44-9.67L80,128,48.49,34.72a8,8,0,0,1,11.44-9.67l168,95.85A8,8,0,0,1,227.91,134.86Z",
  "M231.87,114l-168-95.89A16,16,0,0,0,40.92,37.34L71.55,128,40.92,218.67A16,16,0,0,0,56,240a16.15,16.15,0,0,0,7.93-2.1l167.92-96.05a16,16,0,0,0,.05-27.89ZM56,224a.56.56,0,0,0,0-.12L85.74,136H144a8,8,0,0,0,0-16H85.74L56.06,32.16A.46.46,0,0,0,56,32l168,95.83Z",
];

interface Line {
  id: string;
  /** Null until the server confirms it. Confirmed lines sort by this, and pending ones go last. */
  seq: bigint | null;
  body: string;
  image: ChatMessage["image"];
  /** Held until the server confirms it, so a retry can send it again. */
  file?: File;
  fromVisitor: boolean;
  status: "sent" | "sending" | "failed";
}

const PRESENCE_EVERY_MS = 30_000;
const NEW_REPLY_SHOWN_MS = 5000;

type SceneState = "waiting" | "sending" | "reply" | "away" | "lost" | "empty";

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

const RETRY_LIMIT_MS = 30_000;

/**
 * Adds a confirmed message in commit order. A pending line with the same client ID becomes this
 * message, so a send whose response was lost cannot stay marked as failed or appear twice.
 */
function merge(lines: Line[], message: ChatMessage): Line[] {
  const line: Line = {
    id: message.id,
    seq: BigInt(message.seq),
    // A removed image reads as a note where it was.
    body: message.imageRemoved ? t("imageRemoved") : (message.body ?? ""),
    image: message.image,
    fromVisitor: message.fromVisitor,
    status: "sent",
  };
  const others = lines.filter((other) => other.id !== message.id && other.id !== message.clientId);
  return inCommitOrder(others, line);
}

/** Math.max does not accept a bigint. */
function larger(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** The panel's title bar: the boat's scene, what it means in words, and the close button. */
function ChatHead({
  scene,
  online,
  mascot,
  onClose,
}: {
  scene: SceneState;
  online: boolean | null;
  mascot: boolean;
  onClose(): void;
}) {
  return (
    <div class="head">
      <div class={`scene ${scene === "empty" ? "empty-state" : scene}`}>
        {mascot && (
          <Sea
            class="sea"
            options={HEAD_SEA}
            boat={boatSvg(SCENES[scene].boat, 32)}
            boatClass="ship"
          >
            {scene === "away" && <i class="moon" />}
            {scene === "sending" && <i class="parcel" />}
          </Sea>
        )}
        <div>
          <b>{t("title")}</b>
          <small role="status">
            {t(scene === "waiting" && online === true ? "teamOnline" : SCENES[scene].text)}
          </small>
        </div>
      </div>
      <button type="button" class="action icon" aria-label={t("close")} onClick={onClose}>
        <Icon paths={CLOSE_ICON} size={24} />
      </button>
    </div>
  );
}

/** One message in the log, with its sending state or a retry button. */
function ChatLine({
  line,
  onView,
  onImageError,
  onRetry,
}: {
  line: Line;
  onView(): void;
  onImageError(): void;
  onRetry(): void;
}) {
  return (
    <Fragment>
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

/** Asks a signed-out visitor for an email, so a reply can reach them after they leave. */
function EmailForm({
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

interface ChatProps {
  context: WidgetContext;
  open: boolean;
  setOpen(open: boolean): void;
}

/**
 * One visitor's session. identify() and reset() remount this component, so nothing from the old
 * identity survives: its stream closes, and a late response updates a component that is gone.
 */
function Chat({ context, open, setOpen }: ChatProps) {
  const { publicKey, base } = context;
  const [client] = useState(() => createClient(base, publicKey));
  const [identity] = useState(() => context.getIdentity());
  const [token, setToken] = useState(() =>
    identity === null ? readToken(publicKey) : typeof identity === "string" ? identity : null,
  );
  const [openConversation, setOpenConversation] = useState(false);
  const [lastRead, setLastRead] = useState(0n);
  // The server's count, with the read position it was computed from.
  const [serverRead, setServerRead] = useState({ unread: 0, position: 0n });
  const [loaded, setLoaded] = useState(false);
  // The newest position the stream has delivered. A send's own response does not move this, so a
  // reply that has not arrived yet cannot be marked as read.
  const [delivered, setDelivered] = useState(0n);
  const [renewing, setRenewing] = useState(typeof identity === "function");
  const [renewAttempt, setRenewAttempt] = useState(0);
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const renewDelay = useRef(0);
  const sends = useRef(0);
  const alive = useRef(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [lost, setLost] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [newReply, setNewReply] = useState(false);
  // True once the replay of history has ended, so only a message that arrives later is "new".
  const replayed = useRef(false);
  // Null means unknown, and then the panel says nothing about the team.
  const [online, setOnline] = useState<boolean | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const viewer = useRef<HTMLDialogElement>(null);
  const lastRefresh = useRef(0);
  // False until the server says, so the form never promises an email that this server cannot send.
  const [emailReplies, setEmailReplies] = useState(false);
  const [email, setEmail] = useState("");
  // Or why the last save failed.
  const [emailState, setEmailState] = useState<"idle" | "saved" | "emailInvalid" | "emailFailed">(
    "idle",
  );
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const cursor = useRef<string | null>(null);
  // A closed panel needs only the unread messages, so its stream starts at the read position. The
  // panel's first open then replays the whole history once.
  const readCursor = useRef<string | null>(null);
  const partial = useRef(false);
  // Set when the panel opens on a partial stream. The next stream resets the cursor itself, after
  // the old stream is aborted, so a late event of the old one cannot move the cursor back.
  const wantsReplay = useRef(false);
  const [replay, setReplay] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const creatingVisitor = useRef<Promise<string> | null>(null);

  useEffect(() => {
    alive.current = true;
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    // Another tab may have started a chat, so this tab joins it instead of starting a second one.
    const onStorage = () => {
      // Only a stored token replaces this one. A token held in memory survives a full storage.
      const stored = identity === null ? readToken(publicKey) : null;
      if (stored !== null) setToken(stored);
    };
    addEventListener("storage", onStorage);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("storage", onStorage);
    };
  }, [identity, publicKey]);

  /** Asks the host for a new token now, for a send. It returns null if this identity cannot renew. */
  const renewToken = async (): Promise<string | null> => {
    if (typeof identity !== "function") return null;
    const next = await identity();
    if (alive.current) setToken(next);
    return next;
  };

  // The only background path to a new token. A rejected or failed renewal waits longer each time,
  // so a rotated secret cannot make every tab call the host and this server in a loop. The delay
  // resets only when a token works.
  // biome-ignore lint/correctness/useExhaustiveDependencies: renewAttempt asks for another try.
  useEffect(() => {
    // A hidden tab holds no stream, so it has no use for a token until it returns.
    if (!renewing || !visible || typeof identity !== "function") return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const next = await identity();
        if (stopped) return;
        setToken(next);
        setTokenEpoch((current) => current + 1);
        setRenewing(false);
      } catch {
        if (stopped) return;
        setLost(true);
        setRenewAttempt((current) => current + 1);
      }
    }, renewDelay.current);
    renewDelay.current = Math.min(Math.max(1000, renewDelay.current * 2), RETRY_LIMIT_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [identity, renewing, renewAttempt, visible]);

  useEffect(() => {
    if (!open) return;
    // On a touch screen the keyboard would cover the panel before the visitor reads it, so focus
    // goes to the panel, and a tap on the field opens the keyboard.
    if (matchMedia("(pointer: fine)").matches) input.current?.focus();
    else panel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!newReply) return;
    const timer = setTimeout(() => setNewReply(false), NEW_REPLY_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [newReply]);

  // Only an open panel asks, so a page view costs the server nothing.
  useEffect(() => {
    if (!open || !visible) return;
    const ask = () => {
      client
        .presence()
        .then((state) => {
          setOnline(state.online);
          setEmailReplies(state.emailReplies);
        })
        .catch(() => setOnline(null));
    };
    ask();
    const timer = setInterval(ask, PRESENCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [client, open, visible]);

  // One request when a visible tab has a token gives the unread count and says whether a stream is
  // needed. A visitor with only closed conversations holds no stream. It runs again when a tab
  // becomes visible, because another tab may have read messages or started a conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenEpoch asks for a request.
  useEffect(() => {
    if (token === null || !visible) return;
    // A newer request replaces this one, so a late 401 cannot erase a replacement token.
    let replaced = false;
    const sendsAtStart = sends.current;
    client
      .me(token)
      .then((me) => {
        if (replaced) return;
        renewDelay.current = 0;
        // A send during this request leaves a conversation open that this response may not show.
        setOpenConversation(me.openConversation || sends.current !== sendsAtStart);
        // The larger one, because this response can be older than a read in this tab.
        const position = BigInt(me.lastReadSeq);
        setLastRead((current) => larger(current, position));
        setServerRead({ unread: me.unread, position });
        readCursor.current = me.readCursor;
      })
      .catch((error: unknown) => {
        if (replaced || !(error instanceof ApiError) || error.status !== 401) return;
        if (identity === null) {
          writeToken(publicKey, null);
          setToken(null);
        } else if (typeof identity === "function") {
          setRenewing(true);
        }
      });
    return () => {
      replaced = true;
    };
  }, [client, identity, publicKey, token, tokenEpoch, visible]);

  // Before the stream replays history, the server's count is the only one available.
  // With no stream, as after an operator closes the conversation, the lines can be behind too.
  const unread =
    loaded && (open || openConversation)
      ? lines.filter((line) => !line.fromVisitor && line.seq !== null && line.seq > lastRead).length
      : lastRead > serverRead.position
        ? 0
        : serverRead.unread;
  useEffect(() => context.setUnread(unread), [context, unread]);

  // A message counts as read only when the visitor can see it.
  useEffect(() => {
    if (!open || !visible || !loaded || token === null || delivered <= lastRead) return;
    setLastRead(delivered);
    client.markRead(token, delivered.toString()).catch(() => {
      // The count returns on the next page load, and a later read moves the position past it.
    });
  }, [client, delivered, lastRead, loaded, open, token, visible]);

  // Only the visible tab holds a stream, because browsers allow about six HTTP/1.1 connections per
  // origin across all tabs. A tab catches up from its cursor when it becomes visible again.
  const wantsStream = token !== null && visible && (open || openConversation);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenEpoch asks for a new stream.
  useEffect(() => {
    if (!wantsStream || token === null) return;
    const controller = new AbortController();
    let retryMs = 1000;
    if (wantsReplay.current) {
      wantsReplay.current = false;
      cursor.current = null;
      // The history is not new, so it raises no "new reply" notice.
      replayed.current = false;
    }
    if (cursor.current === null && !open && readCursor.current !== null) {
      cursor.current = readCursor.current;
      partial.current = true;
    }
    (async () => {
      while (!controller.signal.aborted) {
        let refusedMs: number | undefined;
        try {
          const reason = await client.stream(token, cursor.current, controller.signal, {
            message(message, next) {
              if (controller.signal.aborted) return;
              cursor.current = next;
              setDelivered((current) => larger(current, BigInt(message.seq)));
              if (replayed.current && !message.fromVisitor) setNewReply(true);
              setLines((current) => merge(current, message));
            },
            ready(next) {
              if (controller.signal.aborted) return;
              if (next !== null) cursor.current = next;
              replayed.current = true;
              renewDelay.current = 0;
              setLost(false);
              setLoaded(true);
              retryMs = 1000;
            },
            resync(next) {
              if (controller.signal.aborted) return;
              cursor.current = next;
              // It reads from the start now, so the history is whole.
              partial.current = false;
              setLines((current) => current.filter((line) => line.seq === null));
            },
          });
          if (reason === "revoked" || reason === "unauthorized") return;
          if (reason === "expired") {
            // A new token restarts this effect. A plain string cannot renew, so the stream stays
            // closed until the page calls identify() again.
            if (typeof identity === "function") setRenewing(true);
            return;
          }
          if (reason === "lifetime") continue;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) {
            if (typeof identity === "function") setRenewing(true);
            return;
          }
          if (error instanceof ApiError) refusedMs = error.retryMs;
        }
        if (controller.signal.aborted) return;
        setLost(true);
        // A refused stream waits as long as the server says. Otherwise, jitter, so clients do not all
        // return at once after an outage.
        await new Promise((resolve) =>
          setTimeout(resolve, refusedMs ?? retryMs * (0.5 + Math.random() / 2)),
        );
        if (refusedMs === undefined) retryMs = Math.min(retryMs * 2, RETRY_LIMIT_MS);
      }
    })();
    return () => controller.abort();
  }, [client, identity, token, tokenEpoch, wantsStream, replay]);

  // The panel opens on a stream that skipped the read history, so it replays it from the start.
  useEffect(() => {
    if (!open || !partial.current) return;
    partial.current = false;
    wantsReplay.current = true;
    setReplay((current) => current + 1);
  }, [open]);

  // Only a new line scrolls down, because a refresh of the image URLs must not move the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new line or an opened chat asks for a scroll.
  useEffect(() => {
    if (log.current !== null) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length, open]);

  const ensureToken = async (): Promise<string> => {
    if (identity !== null) {
      if (token !== null) return token;
      const renewed = await renewToken();
      if (renewed === null) throw new ApiError(401);
      return renewed;
    }
    const known = token ?? readToken(publicKey);
    if (known !== null) {
      setToken(known);
      return known;
    }
    // Sends made before the first response share one visitor.
    creatingVisitor.current ??= client
      .newVisitor()
      .then((created) => {
        // After reset(), this token belongs to a session that has ended.
        if (alive.current) {
          writeToken(publicKey, created.token);
          setToken(created.token);
        }
        return created.token;
      })
      .finally(() => {
        creatingVisitor.current = null;
      });
    return creatingVisitor.current;
  };

  // The line's first ID is its client ID, so a manual retry cannot create a duplicate.
  const deliver = async (lineId: string, body: string, file?: File) => {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, status: "sending" } : line)),
    );
    try {
      const first = await ensureToken();
      const post = (token: string) =>
        file === undefined
          ? client.send(token, lineId, body)
          : client.sendImage(token, lineId, file);
      const sent = await post(first).catch(async (error: unknown) => {
        // A tab open past the token's expiry asks the host for a new one and tries once more.
        // The client ID makes this safe.
        const renewed =
          error instanceof ApiError && error.status === 401 ? await renewToken() : null;
        if (renewed === null) throw error;
        return post(renewed);
      });
      sends.current += 1;
      setOpenConversation(true);
      // A send that worked means a block was lifted, or the site was allowed again. Another warning,
      // such as an image that was too large, is about something else and stays.
      setProblem((current) =>
        current === t("blocked") || current === t("notHere") ? null : current,
      );
      setLines((current) => merge(current, sent));
    } catch (error) {
      if (file !== undefined && error instanceof ApiError && REFUSED.includes(error.status)) {
        setProblem(t(error.status === 507 ? "imageNoRoom" : "imageFailed"));
        setLines((current) => current.filter((line) => line.id !== lineId));
        return;
      }
      // A block, or a site the workspace no longer serves: its allowed sites changed, or the
      // workspace became read-only or suspended during this visit.
      if (error instanceof ApiError && error.status === 403) {
        setProblem(t(error.code === "origin_not_allowed" ? "notHere" : "blocked"));
      }
      setLines((current) =>
        current.map((line) => (line.id === lineId ? { ...line, status: "failed" } : line)),
      );
    }
  };

  // An image's URL expires after 15 minutes. Replaying from the start gives every line a new one.
  const refreshImages = () => {
    if (Date.now() - lastRefresh.current < REFRESH_LIMIT_MS) return;
    lastRefresh.current = Date.now();
    cursor.current = null;
    setTokenEpoch((current) => current + 1);
  };

  useEffect(() => {
    if (viewing !== null) viewer.current?.showModal();
  }, [viewing]);

  const submit = (event: Event) => {
    event.preventDefault();
    const body = draft.trim();
    if (body === "") return;
    setDraft("");
    const id = newClientId();
    setLines((current) => [
      ...current,
      { id, seq: null, body, image: null, fromVisitor: true, status: "sending" },
    ]);
    void deliver(id, body);
  };

  const sendFiles = (files: Iterable<File>) => {
    // Once, before the loop, so a good file cannot erase the warning about the one before it.
    setProblem(null);
    for (const file of files) {
      const problem = imageProblem(file);
      if (problem !== null) {
        setProblem(t(problem));
        continue;
      }
      const id = newClientId();
      setLines((current) => [
        ...current,
        { id, seq: null, body: "", image: null, file, fromVisitor: true, status: "sending" },
      ]);
      void deliver(id, "", file);
    }
  };

  const saveEmail = async (event: Event) => {
    event.preventDefault();
    try {
      await client.saveEmail(await ensureToken(), email.trim());
      setEmailState("saved");
    } catch (error) {
      // The server checked the address, so only a 400 means it is wrong.
      setEmailState(
        error instanceof ApiError && error.status === 400 ? "emailInvalid" : "emailFailed",
      );
    }
  };

  if (!open) return null;
  // In this order, because a lost connection matters most and an empty chat matters least.
  const sceneState: SceneState = lost
    ? "lost"
    : lines.some((line) => line.status === "sending")
      ? "sending"
      : newReply
        ? "reply"
        : online === false
          ? "away"
          : lines.length === 0 && online === null
            ? "empty"
            : "waiting";

  return (
    <section
      ref={panel}
      tabIndex={-1}
      class={dropping ? "panel drop" : "panel"}
      onDragOver={(event) => {
        // A drag of selected text keeps its normal behavior.
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        sendFiles(event.dataTransfer.files);
      }}
      aria-label={t("title")}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <ChatHead
        scene={sceneState}
        online={online}
        mascot={context.mascot}
        onClose={() => setOpen(false)}
      />
      <div class="log" role="log" aria-live="polite" ref={log}>
        {lines.length === 0 && (
          <div class="empty">
            {context.mascot && (
              <Sea class="port" options={PORT_SEA} boat={boatSvg("sail", 64)} boatClass="hull">
                <i class="sun" />
              </Sea>
            )}
            {/* Away, the header already asks for a message. */}
            {sceneState !== "empty" && sceneState !== "away" && <p>{t("empty")}</p>}
          </div>
        )}
        {lines.map((line) => (
          <ChatLine
            key={line.id}
            line={line}
            onView={() => setViewing(line.id)}
            onImageError={refreshImages}
            onRetry={() => void deliver(line.id, line.body, line.file)}
          />
        ))}
      </div>
      {viewing !== null && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a dialog.
        <dialog
          ref={viewer}
          onClose={() => setViewing(null)}
          onClick={() => viewer.current?.close()}
        >
          <img
            src={lines.find((line) => line.id === viewing)?.image?.url}
            alt={t("imageAlt")}
            onError={refreshImages}
          />
        </dialog>
      )}
      {problem !== null && (
        <div class="notice bad" role="alert">
          {problem}
        </div>
      )}
      {emailState === "saved" && (
        <div class="notice" role="status">
          {t("emailSaved")}
        </div>
      )}
      {/* After the first message, so it takes no space from someone who is only looking. */}
      {emailReplies && identity === null && emailState !== "saved" && lines.length > 0 && (
        <EmailForm
          email={email}
          bad={emailState === "idle" ? null : emailState}
          onInput={setEmail}
          onSubmit={saveEmail}
        />
      )}
      <form onSubmit={submit}>
        <input
          ref={picker}
          class="file"
          type="file"
          multiple
          accept={IMAGE_TYPES.join(",")}
          aria-label={t("attach")}
          tabIndex={-1}
          onChange={(event) => {
            sendFiles(event.currentTarget.files ?? []);
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
            if (data === null || data.files.length === 0 || data.getData("text/plain") !== "")
              return;
            event.preventDefault();
            sendFiles(data.files);
          }}
          ref={input}
          aria-label={t("inputLabel")}
          placeholder={t("inputPlaceholder")}
          maxLength={10_000}
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing(event)) submit(event);
          }}
        />
        <button type="submit" class="action" aria-label={t("send")}>
          <Icon paths={SEND_ICON} size={18} />
        </button>
      </form>
    </section>
  );
}

function Root({ context }: { context: WidgetContext }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  // A layout effect, so identify() or reset() right after the first render still reaches this.
  useLayoutEffect(() => {
    context.setSessionHandler(() => setSession((current) => current + 1));
    context.setOpenHandlers(
      () => setOpen(true),
      () => setOpen(false),
    );
  }, [context]);
  const wasOpen = useRef(false);
  useEffect(() => {
    context.setLauncherHidden(open);
    // The focused element is gone after a close, so a keyboard user returns to the launcher.
    if (!open && wasOpen.current) context.focusLauncher();
    wasOpen.current = open;
  }, [context, open]);
  return <Chat key={session} context={context} open={open} setOpen={setOpen} />;
}

const context = globalThis.__dinghy;
if (context !== undefined) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  context.shadow.adoptedStyleSheets = [...context.shadow.adoptedStyleSheets, sheet];
  const mount = document.createElement("div");
  context.shadow.append(mount);
  render(<Root context={context} />, mount);
}
