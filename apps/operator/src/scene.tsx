/** @jsxImportSource react */
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BOAT_CSS, type BoatKind, boatSvg, logoSvg } from "../../../packages/widget/src/boat.ts";
import { FAR, MIDDLE, NEAR, type SeaOptions, startSea } from "../../../packages/widget/src/sea.ts";
import { type TextId, t } from "./text.ts";

// One set of boat colors for the widget and this app. A constructed sheet passes style-src 'self'.
const boatSheet = new CSSStyleSheet();
boatSheet.replaceSync(BOAT_CSS);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, boatSheet];

/** A moving boat. Each place that shows one also shows text that says the same. */
function Boat({ kind, size }: { kind: BoatKind; size: number }) {
  return (
    <span
      className="ship"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from boat.ts.
      dangerouslySetInnerHTML={{ __html: boatSvg(kind, size) }}
    />
  );
}

/** The product's site. On Dinghy Cloud, the logo on the account screens goes back to it. */
const SITE = "https://dinghy.chat";
let logoLinksHome = false;

/** Set once the server says where it runs. A self-hosted server's screens keep a plain logo. */
export const setLogoLinksHome = (cloud: boolean) => {
  logoLinksHome = cloud;
};

export function Logo() {
  return (
    <span className="logo">
      <span
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from boat.ts.
        dangerouslySetInnerHTML={{ __html: logoSvg(30) }}
      />
      {t("brand")}
    </span>
  );
}

// The landing page's three swells, as each scene sets them.
const PATCH: SeaOptions = {
  layers: [
    { level: 0.5, swell: 2.5, ...FAR },
    { level: 0.68, swell: 3, ...MIDDLE },
    { level: 0.86, swell: 3, ...NEAR },
  ],
  boatLayer: 1,
  boatAt: 0.45,
  drift: 10,
  sunAt: 0.78,
};
const POND: SeaOptions = { ...PATCH, boatAt: 0.5, drift: 8, sunAt: undefined };
const SHORE: SeaOptions = {
  layers: [
    { level: 0.52, swell: 3, ...FAR },
    { level: 0.7, swell: 4, ...MIDDLE },
    { level: 0.87, swell: 4, ...NEAR },
  ],
  boatLayer: 1,
  boatAt: 0.2,
  drift: 16,
};

const lessMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A boat riding layers of moving swell. The boat and the water are pictures: the place that shows
 * them also shows text that says the same. A new `boatAt` or `sunAt` glides there.
 */
function Sea({
  className,
  options,
  boatAt = options.boatAt,
  sunAt = options.sunAt,
  size,
  children,
}: {
  className: string;
  options: SeaOptions;
  boatAt?: number;
  sunAt?: number | undefined;
  size: number;
  children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The sea reads these each frame, so a change moves the boat without a new start.
  const live = useRef<SeaOptions>({ ...options, boatAt, sunAt });
  const stop = useRef(() => {});
  const start = useCallback(() => {
    stop.current();
    stop.current = host.current ? startSea(host.current, live.current) : () => {};
  }, []);
  useEffect(() => {
    live.current = { ...options, boatAt: live.current.boatAt, sunAt: live.current.sunAt };
    start();
    return () => stop.current();
  }, [options, start]);
  useEffect(() => {
    live.current.boatAt = boatAt;
    live.current.sunAt = sunAt;
    // With reduced motion the sea is still, so it starts again in its new place.
    if (lessMotion()) start();
  }, [boatAt, sunAt, start]);
  return (
    <div className={`sea ${className}`} ref={host} aria-hidden="true">
      {children}
      <canvas className="sea-back" />
      <span className="float">
        <Boat kind="sail" size={size} />
      </span>
      <canvas className="sea-front" />
    </div>
  );
}

/** The boat on a small patch of sea in the sun, with the text that says the same thing. */
export function Harbor({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="harbor">
      <Sea className="harbor-art" options={PATCH} size={96}>
        <span className="harbor-sun" />
      </Sea>
      <b>{title}</b>
      {children !== undefined && <p>{children}</p>}
    </div>
  );
}

/** A smaller patch of sea, for an empty list. */
export function Pond() {
  return <Sea className="pond" options={POND} size={64} />;
}

/**
 * A drawing for an empty list: the boat in the day for an empty inbox, and the same boat under the
 * moon for an empty list of closed conversations. The text beside it says the same.
 */
export function EmptyArt({ scene }: { scene: "day" | "evening" }) {
  return (
    <svg className="empty-art" viewBox="0 0 120 120" aria-hidden="true">
      <rect className="empty-sky" width="120" height="120" />
      <circle className="empty-sun" cx="30" cy="38" r="10" />
      {scene === "evening" && (
        <>
          <circle className="empty-sky" cx="35" cy="34" r="9" />
          <path
            className="empty-star"
            d="M88 30l1.2 3.3 3.3 1.2-3.3 1.2L88 39l-1.2-3.3-3.3-1.2 3.3-1.2zM98 46l.8 2.2 2.2.8-2.2.8L98 52l-.8-2.2-2.2-.8 2.2-.8z"
          />
        </>
      )}
      <path
        className="empty-water"
        d="M0 82c10 0 10-3 20-3s10 3 20 3 10-3 20-3 10 3 20 3 10-3 20-3 10 3 20 3V120H0z"
      />
      <path className="empty-ink" d="M58 26v52" />
      <path className="empty-flag" d="M60 26l11 4-11 4z" />
      <path className="empty-sail" d="M61 38c10 8 16 20 18 34H61z" />
      <path className="empty-sail" d="M55 44c-7 9-12 18-15 28h15z" />
      <path className="empty-hull" d="M33 76h52c-2 7-8 11-15 11H48c-7 0-13-4-15-11z" />
      <path className="empty-ripple" d="M24 98h14M50 98h20M82 98h14M38 108h44" />
    </svg>
  );
}

/**
 * The account screens follow one day: sign in in the early morning, the email by mid-morning, the
 * link at midday and the workspace's setup in the afternoon.
 */
type TimeOfDay = "morning" | "forenoon" | "noon" | "afternoon";

/** Where the boat rests and where the sun lies, as shares of the width, at each time of day. */
const DAY: Record<TimeOfDay, { boatAt: number; sunAt: number }> = {
  morning: { boatAt: 0.16, sunAt: 0.14 },
  forenoon: { boatAt: 0.32, sunAt: 0.17 },
  noon: { boatAt: 0.52, sunAt: 0.79 },
  afternoon: { boatAt: 0.76, sunAt: 0.86 },
};

/** The words for each time of day, so the moving scene also has text. */
const DAY_TEXT: Record<TimeOfDay, TextId> = {
  morning: "sceneMorning",
  forenoon: "sceneForenoon",
  noon: "sceneNoon",
  afternoon: "sceneAfternoon",
};

/**
 * AuthPage tells the app it is on screen, and at what time of day, so the sky and the sea behind
 * it stay mounted.
 */
const SceneUse = createContext<{ use(change: number): void; at(time: TimeOfDay): void }>({
  use() {},
  at() {},
});

function useScene(time?: TimeOfDay) {
  const scene = useContext(SceneUse);
  // A layout effect, so a screen that replaces another adds itself before the paint. The count
  // never reaches zero between them, and the sea keeps moving.
  useLayoutEffect(() => {
    scene.use(1);
    return () => scene.use(-1);
  }, [scene]);
  useLayoutEffect(() => {
    if (time !== undefined) scene.at(time);
  }, [scene, time]);
}

/** The sun shows only on wider screens. */
const wide = () => matchMedia("(min-width: 761px)").matches;

/**
 * The landing page's sky and sea, behind every screen for someone who is not signed in. It stays
 * mounted while one card replaces another, so only the card changes, and the sky, the sun and the
 * boat glide to the time of day of each step.
 */
export function Scene({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState(0);
  const [time, setTime] = useState<TimeOfDay>("morning");
  const scene = useMemo(
    () => ({
      use: (change: number) => setUsers((current) => current + change),
      at: setTime,
    }),
    [],
  );
  return (
    <SceneUse.Provider value={scene}>
      {users > 0 && (
        <div className={`scene ${time}`} aria-hidden="true">
          <div className="sky">
            <span className="cloud cloud-a" />
            <span className="cloud cloud-b" />
            <span className="sun" />
          </div>
          <Sea
            className="shore"
            options={SHORE}
            boatAt={DAY[time].boatAt}
            sunAt={wide() ? DAY[time].sunAt : undefined}
            size={150}
          />
        </div>
      )}
      {users > 0 && <p className="visually-hidden">{t(DAY_TEXT[time])}</p>}
      {children}
    </SceneUse.Provider>
  );
}

/** The sky and the sea with no card, while an account screen loads. */
export function SceneLoading() {
  useScene();
  return (
    <main className="signin">
      <p className="visually-hidden" role="status">
        {t("loading")}
      </p>
    </main>
  );
}

/**
 * The app's frame with nothing in it yet, while a signed-in operator's app loads, so the first
 * screen is the shape of the next one.
 */
export function ShellLoading() {
  return (
    <div className="shell">
      <div className="app">
        <aside className="side">
          <div className="brand">
            <Logo />
          </div>
        </aside>
        <main className="panel" aria-busy="true">
          <p className="visually-hidden" role="status">
            {t("loading")}
          </p>
        </main>
      </div>
    </div>
  );
}

/**
 * The page for everyone who is not signed in: one card over the sky and the sea from the landing
 * page, at the step's time of day. With onSubmit, the card is a form.
 */
export function AuthPage({
  time,
  onSubmit,
  children,
}: {
  /** The step's time of day. Without one, the scene stays where it is. */
  time?: TimeOfDay;
  onSubmit?(event: FormEvent): void;
  children: ReactNode;
}) {
  useScene(time);
  const content = (
    <>
      {logoLinksHome ? (
        <a className="logo-home" href={SITE} aria-label={t("backToSite")}>
          <Logo />
        </a>
      ) : (
        <Logo />
      )}
      {children}
    </>
  );
  // A new step is a new card, so it fades in while the scene stays.
  return (
    <main className="signin">
      {onSubmit === undefined ? (
        <div className="card" key={time}>
          {content}
        </div>
      ) : (
        <form className="card" key={time} onSubmit={onSubmit}>
          {content}
        </form>
      )}
    </main>
  );
}
