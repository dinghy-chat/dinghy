/** @jsxImportSource react */
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { WorkspaceApi } from "./api.ts";
import { isEmptyInbox, type PaneLook } from "./empty-look.ts";
import { createFlights, type Flights, type Pickup } from "./flight.ts";
import {
  BIG_SCENE,
  BOARD_POST_TOP,
  createPerch,
  type Perch,
  type PerchMode,
  type PerchSize,
  type PondExtra,
} from "./perch.ts";
import { isLessMotion } from "./pixel.ts";
import { takesKeys, useShortcutsOn } from "./shortcuts.tsx";
import { plural, type TextId, t } from "./text.ts";
import { failureText } from "./ui.tsx";

/** Left alone this long, the gull stretches its wings. */
const IDLE_MS = 30_000;
/** Woken from its nap, the gull dozes off again after this. */
const NAP_AFTER_WAKE_MS = 6000;
/** A cleared search keeps the scene this long, so the gull can lower its telescope and squawk. */
const CLEAR_HOLD_MS = 600;
const SMALL_SCALE = 3;
const BIG_SCALE = { most: 6, least: 2 };
/** The pane's padding, and the room the title and its line take under the scene. */
const PANE_ROOM_PX = { across: 48, down: 150 };
/** Typed outside a field, this gives the gull its hat. */
const HAT_WORD = "ahoy";
/** The key that opens the first conversation, from inbox.tsx's shortcuts. */
const FIRST_ROW_KEY = "J";

type SceneKind = Exclude<PaneLook["kind"], "pick" | "loading">;
type SceneLook = Extract<PaneLook, { kind: SceneKind }>;

const SCENES: Record<
  SceneKind,
  { mode: PerchMode; extra: PondExtra; label: TextId; title: TextId; hint: TextId }
> = {
  caughtUp: {
    mode: "sleep",
    extra: null,
    label: "gullAsleep",
    title: "caughtUp",
    hint: "caughtUpHint",
  },
  noMatch: {
    mode: "search",
    extra: null,
    label: "gullSearching",
    title: "noMatchTitle",
    hint: "noMatchSearchHint",
  },
  board: {
    mode: "idle",
    extra: "board",
    label: "gullBoard",
    title: "boardTitle",
    hint: "boardHint",
  },
  waitingSetup: {
    mode: "idle",
    extra: null,
    label: "gullPost",
    title: "waitingSetupTitle",
    hint: "waitingSetupHint",
  },
  live: { mode: "idle", extra: "skiff", label: "gullSkiff", title: "liveTitle", hint: "liveHint" },
};

const sceneHint = (look: SceneLook): TextId =>
  look.kind === "noMatch" && look.by === "filter" ? "noMatchFilterHint" : SCENES[look.kind].hint;

/**
 * A scene the pane keeps a moment after the list changed: `cleared` while the gull lowers its
 * telescope, `landed` once the first conversation came into an empty inbox.
 */
type Held = { look: SceneLook; why: "cleared" | "landed" };

const lookKey = (look: PaneLook) => (look.kind === "noMatch" ? `noMatch-${look.by}` : look.kind);

function nextHeld(from: PaneLook, to: PaneLook): Held | null {
  if (to.kind === "pick" && !to.bySearch && isEmptyInbox(from)) {
    return { look: from, why: "landed" };
  }
  if (from.kind === "noMatch" && to.kind !== "noMatch" && !isLessMotion()) {
    return { look: from, why: "cleared" };
  }
  return null;
}

/** The scene to show, which can lag behind the list's look for the gull's sake. */
function useHeld(look: PaneLook): Held | null {
  const key = lookKey(look);
  const [shown, setShown] = useState({ key, look });
  const [held, setHeld] = useState<Held | null>(null);
  // Set while rendering, so the first frame of the new look already holds the old scene.
  if (shown.key !== key) {
    setShown({ key, look });
    setHeld(nextHeld(shown.look, look));
  }
  useEffect(() => {
    if (held?.why !== "cleared") return;
    const timer = setTimeout(() => setHeld(null), CLEAR_HOLD_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return held;
}

/** The pane's biggest whole scale that leaves room for the words. */
function useFitScale(pane: RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(BIG_SCALE.most);
  useEffect(() => {
    const element = pane.current;
    if (element === null) return;
    const watcher = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      const fits = Math.min(
        Math.floor((width - PANE_ROOM_PX.across) / BIG_SCENE.w),
        Math.floor((height - PANE_ROOM_PX.down) / BIG_SCENE.h),
      );
      setScale(Math.max(BIG_SCALE.least, Math.min(BIG_SCALE.most, fits)));
    });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [pane]);
  return scale;
}

/** A gull on its canvas, and its flights at the same scale. */
function useGull(size: PerchSize, scale: number) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const perch = useRef<Perch | null>(null);
  const flights = useRef<Flights | null>(null);
  const firstScale = useRef(scale);
  useEffect(() => {
    if (canvas.current === null) return;
    const made = createPerch(canvas.current, size, firstScale.current);
    perch.current = made;
    return () => {
      made.stop();
      perch.current = null;
    };
  }, [size]);
  useEffect(() => {
    perch.current?.setScale(scale);
    const made = createFlights(scale);
    flights.current = made;
    const gull = perch.current;
    if (gull !== null) {
      // Flights are motion, so someone who asks for less gets the squawk alone.
      gull.onLoop = () => {
        if (!isLessMotion()) made.loop(gull);
      };
      gull.onSecondLeap = (fish, take) => {
        if (!isLessMotion()) made.snatch(gull, fish, take);
      };
    }
    return () => {
      made.stop();
      flights.current = null;
    };
  }, [scale]);
  useGullLife(perch);
  return { canvas, perch, flights };
}

/** The idle stretch, and the hat that "ahoy" finds, typed anywhere but where keys are taken. */
function useGullLife(perch: RefObject<Perch | null>) {
  useEffect(() => {
    let idle = 0;
    let typed = "";
    const rest = () => {
      clearTimeout(idle);
      idle = window.setTimeout(() => {
        perch.current?.stretch();
        rest();
      }, IDLE_MS);
    };
    const onKey = (event: KeyboardEvent) => {
      rest();
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      if (takesKeys(event.target)) return;
      typed = (typed + event.key.toLowerCase()).slice(-HAT_WORD.length);
      const gull = perch.current;
      if (typed !== HAT_WORD || gull === null) return;
      gull.hatOn = !gull.hatOn;
      gull.squawk();
    };
    rest();
    addEventListener("pointermove", rest);
    addEventListener("pointerdown", rest);
    addEventListener("keydown", onKey);
    return () => {
      clearTimeout(idle);
      removeEventListener("pointermove", rest);
      removeEventListener("pointerdown", rest);
      removeEventListener("keydown", onKey);
    };
  }, [perch]);
}

/** Puts the gull in the scene's mode. Poked while asleep, it wakes with a squawk, then naps again. */
function useMode(perch: RefObject<Perch | null>, mode: PerchMode, extra: PondExtra) {
  useEffect(() => {
    const gull = perch.current;
    if (gull === null) return;
    gull.setExtra(extra);
    if (gull.mode !== "away") gull.setMode(mode);
    if (mode !== "sleep") return;
    let nap = 0;
    gull.onWake = () => {
      gull.setMode("idle");
      gull.squawk();
      clearTimeout(nap);
      nap = window.setTimeout(() => {
        if (gull.mode === "idle") gull.setMode("sleep");
      }, NAP_AFTER_WAKE_MS);
    };
    return () => {
      clearTimeout(nap);
      gull.onWake = null;
    };
  }, [perch, mode, extra]);
}

/** A line with the key that opens the first conversation in it. */
function KeyLine({ text }: { text: TextId }) {
  const [before, after] = t(text).split("{key}");
  return (
    <p className="gull-sub gull-key">
      {before}
      <kbd>{FIRST_ROW_KEY}</kbd>
      {after}
    </p>
  );
}

/** Where the letter lands: the face of the list's first row. */
function firstRowSpot() {
  const face = document.querySelector(".list .rows .avatar-wrap")?.getBoundingClientRect();
  return face === undefined
    ? null
    : { x: face.left + face.width / 2, y: face.top + face.height / 2 };
}

/** The board on its post: a field and a Send key that write to the inbox as a test visitor. */
function Board({
  api,
  scale,
  form,
  onSending,
  onSent,
}: {
  api: WorkspaceApi;
  scale: number;
  form: RefObject<HTMLFormElement | null>;
  onSending(isSending: boolean): void;
  onSent(): void;
}) {
  const [text, setText] = useState("");
  const [isSending, setSending] = useState(false);
  const [failure, setFailure] = useState<TextId | null>(null);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    onSending(true);
    try {
      await api.sendTestMessage(text.trim());
      setText("");
      onSent();
    } catch (error) {
      onSending(false);
      setFailure(failureText(error, {}, "actionFailed"));
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      ref={form}
      className="gull-board"
      style={{ left: BOARD_POST_TOP.x * scale, top: BOARD_POST_TOP.y * scale }}
      onSubmit={send}
    >
      <input
        aria-label={t("boardLabel")}
        placeholder={t("boardPlaceholder")}
        autoComplete="off"
        maxLength={1000}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="gull-send" disabled={text.trim() === "" || isSending}>
        {t("send")}
      </button>
      {failure !== null && (
        <p className="gull-board-note" role="alert">
          {t(failure)}
        </p>
      )}
    </form>
  );
}

/** The gull's big scene in the empty pane, with its title and line under it. */
function GullScene({
  look,
  why,
  rowCount,
  api,
}: {
  look: SceneLook;
  why: Held["why"] | null;
  rowCount: number;
  api: WorkspaceApi;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLFormElement>(null);
  const scale = useFitScale(pane);
  const { canvas, perch, flights } = useGull("big", scale);
  const scene = SCENES[look.kind];
  const keysOn = useShortcutsOn();
  useMode(perch, why === null ? scene.mode : "idle", scene.extra);
  // A test sent from the board flies from there. Set on Send, as the row can come before the answer.
  const isFromBoard = useRef(false);

  const deliver = (from: Pickup["from"]) => {
    const gull = perch.current;
    const box = (from === "board" ? board.current : pane.current)?.getBoundingClientRect();
    const spot = firstRowSpot();
    // A phone shows the list without this pane, and a bird flying from it would come from nowhere.
    const isPaneShown = (pane.current?.getClientRects().length ?? 0) > 0;
    if (gull === null || box === undefined || spot === null || !isPaneShown || isLessMotion()) {
      return;
    }
    void flights.current?.deliver(gull, { from, box }, spot);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new hold plays once.
  useEffect(() => {
    if (why === "cleared") perch.current?.squawk();
    if (why === "landed") deliver(isFromBoard.current ? "board" : "pane");
  }, [why]);

  return (
    <div className="gull-pane" ref={pane}>
      <div className="gull-stage">
        <canvas ref={canvas} role="img" aria-label={t(scene.label)} />
        {look.kind === "board" && (
          <Board
            api={api}
            scale={scale}
            form={board}
            onSending={(isSending) => {
              isFromBoard.current = isSending;
            }}
            onSent={() => {
              // The first test lands when its row comes. A later one flies from the board now.
              if (why === "landed") deliver("board");
            }}
          />
        )}
      </div>
      <h3>{why === "landed" ? plural(rowCount, "arrivedOne", "arrivedMany") : t(scene.title)}</h3>
      {why === "landed" ? (
        keysOn && <KeyLine text="arrivedKey" />
      ) : (
        <p className="gull-sub">{t(sceneHint(look))}</p>
      )}
    </div>
  );
}

/** The list has rows and none is open: the words, and the small gull on its post in the corner. */
function CornerGull() {
  const { canvas } = useGull("small", SMALL_SCALE);
  const keysOn = useShortcutsOn();
  return (
    <div className="gull-pane">
      <h3>{t("pickOne")}</h3>
      {keysOn && <KeyLine text="pickOneKey" />}
      <canvas ref={canvas} className="gull-corner" role="img" aria-label={t("gullPost")} />
    </div>
  );
}

/**
 * The pane beside the list while no conversation is open. Each scene's title and line say what
 * the moving gull shows, and the gull keeps still for someone who asks for less motion.
 */
export function GullPane({
  look,
  rowCount,
  api,
}: {
  look: PaneLook;
  /** The conversations in the list, for the words after the first ones come in. */
  rowCount: number;
  api: WorkspaceApi;
}) {
  const held = useHeld(look);
  const scene = held?.look ?? look;
  if (scene.kind === "loading") return <div className="gull-pane" />;
  if (scene.kind === "pick") return <CornerGull />;
  return <GullScene look={scene} why={held?.why ?? null} rowCount={rowCount} api={api} />;
}
