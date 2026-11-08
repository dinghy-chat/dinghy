/** @jsxImportSource react */
import {
  createContext,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
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
import { ApiError, type Role } from "./api.ts";
import { navigate } from "./nav.ts";
import { type TextId, t } from "./text.ts";

// One set of boat colors for the widget and this app. A constructed sheet passes style-src 'self'.
const boatSheet = new CSSStyleSheet();
boatSheet.replaceSync(BOAT_CSS);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, boatSheet];

export const ROLE_TEXT: Record<Role, TextId> = {
  owner: "roleOwner",
  admin: "roleAdmin",
  agent: "roleAgent",
};

/** Answers that mean the same thing wherever they come from, by the server's error code. */
const BY_CODE: Record<string, TextId> = {
  operator_limit: "operatorLimit",
  storage_full: "imageNoRoom",
  suspended: "suspendedRefused",
  read_only: "readOnlyRefused",
  payment_required: "paymentRequiredRefused",
};

/**
 * The text for a failed request: by its code, then by its status, then 429 as too many requests.
 * Any other answer reads as a general failure, and a request with no answer (offline, timed out)
 * reads as `noAnswer`.
 */
export function failureText(
  failure: unknown,
  byStatus: Partial<Record<number, TextId>>,
  noAnswer: TextId = "somethingFailed",
): TextId {
  if (!(failure instanceof ApiError)) return noAnswer;
  return (
    (failure.code === null ? undefined : BY_CODE[failure.code]) ??
    byStatus[failure.status] ??
    (failure.status === 429 ? "tooManyRequests" : "somethingFailed")
  );
}

/** Opens a dialog as a modal when it mounts. */
export function useModal(): RefObject<HTMLDialogElement | null> {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return dialog;
}

export function ErrorNote({ text }: { text: TextId | null }) {
  if (text === null) return null;
  return (
    <p className="bad" role="alert">
      {t(text)}
    </p>
  );
}

export function StatusNote({ text }: { text: TextId | null }) {
  if (text === null) return null;
  return (
    <p className="note" role="status">
      {t(text)}
    </p>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  label: string;
  value: string;
  onChange(value: string): void;
}

export function Field({ label, value, onChange, ...input }: FieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/**
 * A link to another screen of the app. It moves in place, as the app's buttons do, and still
 * opens a new tab with a modifier key or the middle button.
 */
export function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

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

/** The loading state, or why the load failed once it has. */
export function Loading({ failure = null }: { failure?: TextId | null }) {
  if (failure !== null) {
    return (
      <div className="nothing">
        <ErrorNote text={failure} />
      </div>
    );
  }
  return (
    <div className="nothing loading">
      <Pond />
      <p>{t("loading")}</p>
    </div>
  );
}

const TINT_COUNT = 4;

/** Up to two initials: "Maya Chen" gives "MC", and "maya@example.com" gives "M". */
export function initials(name: string): string {
  const words = name.split(/[\s@._-]+/).filter((word) => word !== "");
  const first = words[0] ?? name;
  const second = name.includes("@") ? undefined : words[1];
  return [first, second]
    .flatMap((word) => [...(word ?? "")].slice(0, 1))
    .join("")
    .toUpperCase();
}

/** A round tile with initials. The same name always gets the same tint. */
export function Avatar({ name }: { name: string }) {
  const sum = [...name].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
  return (
    <span className={`avatar tint-${sum % TINT_COUNT}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// Phosphor Icons (MIT), duotone weight: the light layer first, then the main one. The CSS
// gives the light layer a brand color that fits its place.
const ICONS = {
  inbox: [
    "M216,48V160H179.31a8,8,0,0,0-5.66,2.34l-19.31,19.32a8,8,0,0,1-5.66,2.34H107.31a8,8,0,0,1-5.66-2.34L82.34,162.34A8,8,0,0,0,76.68,160H40V48a8,8,0,0,1,8-8H208A8,8,0,0,1,216,48Z",
    "M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Zm0,16V152h-28.7A15.86,15.86,0,0,0,168,156.69L148.69,176H107.31L88,156.68A15.89,15.89,0,0,0,76.69,152H48V48Zm0,160H48V168H76.69L96,187.32A15.89,15.89,0,0,0,107.31,192h41.38A15.86,15.86,0,0,0,160,187.31L179.31,168H208v40Z",
  ],
  done: [
    "M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z",
    "M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
  ],
  gear: [
    "M230.1,108.76,198.25,90.62c-.64-1.16-1.31-2.29-2-3.41l-.12-36A104.61,104.61,0,0,0,162,32L130,49.89c-1.34,0-2.69,0-4,0L94,32A104.58,104.58,0,0,0,59.89,51.25l-.16,36c-.7,1.12-1.37,2.26-2,3.41l-31.84,18.1a99.15,99.15,0,0,0,0,38.46l31.85,18.14c.64,1.16,1.31,2.29,2,3.41l.12,36A104.61,104.61,0,0,0,94,224l32-17.87c1.34,0,2.69,0,4,0L162,224a104.58,104.58,0,0,0,34.08-19.25l.16-36c.7-1.12,1.37-2.26,2-3.41l31.84-18.1A99.15,99.15,0,0,0,230.1,108.76ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z",
    "M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A111.92,111.92,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.63a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.1,8.1,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8,8,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z",
  ],
  chart: [
    "M208,40V200H152V40Z",
    "M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z",
  ],
  bell: [
    "M208,192H48a8,8,0,0,1-6.88-12C47.71,168.6,56,139.81,56,104a72,72,0,0,1,144,0c0,35.82,8.3,64.6,14.9,76A8,8,0,0,1,208,192Z",
    "M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z",
  ],
  exit: [
    "M224,56V200a16,16,0,0,1-16,16H48V40H208A16,16,0,0,1,224,56Z",
    "M120,216a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H56V208h56A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z",
  ],
  search: [
    "M192,112a80,80,0,1,1-80-80A80,80,0,0,1,192,112Z",
    "M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z",
  ],
  clip: [
    "M180.75,104.75,204,128l-82.06,81.94a48,48,0,0,1-67.88-67.88L153.37,41.37a32,32,0,0,1,45.26,45.26Z",
    "M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z",
  ],
  back: [
    "",
    "M168.49,199.51a12,12,0,0,1-17,17l-80-80a12,12,0,0,1,0-17l80-80a12,12,0,0,1,17,17L97,128Z",
  ],
  // For these, the light layer is a square behind the mark, so they draw the mark alone.
  check: [
    "",
    "M205.66,85.66l-96,96a8,8,0,0,1-11.32,0l-40-40a8,8,0,0,1,11.32-11.32L104,164.69l90.34-90.35a8,8,0,0,1,11.32,11.32Z",
  ],
  plus: [
    "",
    "M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z",
  ],
  close: [
    "",
    "M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z",
  ],
  dots: [
    "",
    "M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm56-12a12,12,0,1,0,12,12A12,12,0,0,0,196,116ZM60,116a12,12,0,1,0,12,12A12,12,0,0,0,60,116Z",
  ],
  // Bold, single-layer marks for small controls.
  chevron: [
    "",
    "M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z",
  ],
  chevronRight: [
    "",
    "M184.49,136.49l-80,80a12,12,0,0,1-17-17L159,128,87.51,56.49a12,12,0,1,1,17-17l80,80A12,12,0,0,1,184.49,136.49Z",
  ],
  arrowUp: [
    "",
    "M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z",
  ],
  plusBold: [
    "",
    "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z",
  ],
  lock: [
    "M216,96V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8H208A8,8,0,0,1,216,96Z",
    "M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z",
  ],
  link: [
    "M209.94,113.94l-96,96a48,48,0,0,1-67.88-67.88l96-96a48,48,0,0,1,67.88,67.88Z",
    "M165.66,90.34a8,8,0,0,1,0,11.32l-64,64a8,8,0,0,1-11.32-11.32l64-64A8,8,0,0,1,165.66,90.34ZM215.6,40.4a56,56,0,0,0-79.2,0L106.34,70.45a8,8,0,0,0,11.32,11.32l30.06-30a40,40,0,0,1,56.57,56.56l-30.07,30.06a8,8,0,0,0,11.31,11.32L215.6,119.6a56,56,0,0,0,0-79.2ZM138.34,174.22l-30.06,30.06a40,40,0,1,1-56.56-56.57l30.05-30.05a8,8,0,0,0-11.32-11.32L40.4,136.4a56,56,0,0,0,79.2,79.2l30.06-30.07a8,8,0,0,0-11.32-11.31Z",
  ],
  eye: [
    "M128,56C48,56,16,128,16,128s32,72,112,72,112-72,112-72S208,56,128,56Zm0,112a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z",
    "M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z",
  ],
  eyeOff: [
    "M128,56C48,56,16,128,16,128s32,72,112,72,112-72,112-72S208,56,128,56Zm0,112a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z",
    "M53.92,34.62A8,8,0,1,0,42.08,45.38L61.32,66.55C25,88.84,9.38,123.2,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208a127.11,127.11,0,0,0,52.07-10.83l22,24.21a8,8,0,1,0,11.84-10.76Zm47.33,75.84,41.67,45.85a32,32,0,0,1-41.67-45.85ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.16,133.16,0,0,1,25,128c4.69-8.79,19.66-33.39,47.35-49.38l18,19.75a48,48,0,0,0,63.66,70l14.73,16.2A112,112,0,0,1,128,192Zm6-95.43a8,8,0,0,1,3-15.72,48.16,48.16,0,0,1,38.77,42.64,8,8,0,0,1-7.22,8.71,6.39,6.39,0,0,1-.75,0,8,8,0,0,1-8-7.26A32.09,32.09,0,0,0,134,96.57Zm113.28,34.69c-.42.94-10.55,23.37-33.36,43.8a8,8,0,1,1-10.67-11.92A132.77,132.77,0,0,0,231.05,128a133.15,133.15,0,0,0-23.12-30.77C185.67,75.19,158.78,64,128,64a118.37,118.37,0,0,0-19.36,1.57A8,8,0,1,1,106,49.79,134,134,0,0,1,128,48c34.88,0,66.57,13.26,91.66,38.35,18.83,18.83,27.3,37.62,27.65,38.41A8,8,0,0,1,247.31,131.26Z",
  ],
  copy: [
    "M216,40V168H168V88H88V40Z",
    "M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z",
  ],
  trash: [
    "M200,56V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V56Z",
    "M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z",
  ],
  user: [
    "M192,96a64,64,0,1,1-64-64A64,64,0,0,1,192,96Z",
    "M230.92,212c-15.23-26.33-38.7-45.21-66.09-54.16a72,72,0,1,0-73.66,0C63.78,166.78,40.31,185.66,25.08,212a8,8,0,1,0,13.85,8c18.84-32.56,52.14-52,89.07-52s70.23,19.44,89.07,52a8,8,0,1,0,13.85-8ZM72,96a56,56,0,1,1,56,56A56.06,56.06,0,0,1,72,96Z",
  ],
  prohibit: [
    "M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z",
    "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm88,104a87.56,87.56,0,0,1-20.41,56.28L71.72,60.4A88,88,0,0,1,216,128ZM40,128A87.56,87.56,0,0,1,60.41,71.72L184.28,195.6A88,88,0,0,1,40,128Z",
  ],
  plusCircle: [
    "M224,128a96,96,0,1,1-96-96A96,96,0,0,1,224,128Z",
    "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm48-88a8,8,0,0,1-8,8H136v32a8,8,0,0,1-16,0V136H88a8,8,0,0,1,0-16h32V88a8,8,0,0,1,16,0v32h32A8,8,0,0,1,176,128Z",
  ],
} satisfies Record<string, [string, string]>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const [light, main] = ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      {light !== "" && <path className="duo" d={light} />}
      <path d={main} />
    </svg>
  );
}

/**
 * A page inside the white panel: a large title, one line of context, and the page's actions on the
 * right as pills.
 */
export function Page({
  title,
  context,
  actions,
  children,
}: {
  title: string;
  context?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page" aria-label={title}>
      <PageHead title={title} context={context} actions={actions} />
      <div className="page-body">{children}</div>
    </section>
  );
}

/** The title, its line of context and the actions, at the top of a page or of the inbox list. */
export function PageHead({
  title,
  context,
  actions,
}: {
  title: string;
  context?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-title">
        <h2>{title}</h2>
        {context !== undefined && <p>{context}</p>}
      </div>
      {actions !== undefined && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/**
 * One row of a page: a title and its help on the left, the controls on the right, and a thin line
 * between rows. A danger row, for what cannot be undone, has a red outline.
 */
export function PageRow({
  title,
  help,
  danger = false,
  children,
}: {
  title: ReactNode;
  help?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={danger ? "page-row danger-zone" : "page-row"}>
      <div className="page-about">
        <h3>{title}</h3>
        {help !== undefined && <p className="hint">{help}</p>}
      </div>
      <div className="page-controls">{children}</div>
    </section>
  );
}

/**
 * The account screens follow one day: sign in in the early morning, the email by mid-morning, the
 * link at midday and the workspace's setup in the afternoon.
 */
export type TimeOfDay = "morning" | "forenoon" | "noon" | "afternoon";

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
