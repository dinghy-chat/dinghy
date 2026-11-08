/** @jsxImportSource react */
import {
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import { BOAT_CSS, type BoatKind, boatSvg, logoSvg } from "../../../packages/widget/src/boat.ts";
import { FAR, MIDDLE, NEAR, type SeaOptions, startSea } from "../../../packages/widget/src/sea.ts";
import { ApiError, type Role } from "./api.ts";
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
  // The sun shows only on wider screens.
  sunAt: matchMedia("(min-width: 761px)").matches ? 0.8 : undefined,
};

/** A boat riding layers of moving swell. The boat and the water are pictures: the place that shows them also shows text that says the same. */
function Sea({
  className,
  options,
  size,
  children,
}: {
  className: string;
  options: SeaOptions;
  size: number;
  children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => (host.current ? startSea(host.current, options) : undefined), [options]);
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
function initials(name: string): string {
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
  bell: [
    "M208,192H48a8,8,0,0,1-6.88-12C47.71,168.6,56,139.81,56,104a72,72,0,0,1,144,0c0,35.82,8.3,64.6,14.9,76A8,8,0,0,1,208,192Z",
    "M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z",
  ],
  exit: [
    "M224,56V200a16,16,0,0,1-16,16H48V40H208A16,16,0,0,1,224,56Z",
    "M120,216a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H56V208h56A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z",
  ],
  clip: [
    "M180.75,104.75,204,128l-82.06,81.94a48,48,0,0,1-67.88-67.88L153.37,41.37a32,32,0,0,1,45.26,45.26Z",
    "M209.66,122.34a8,8,0,0,1,0,11.32l-82.05,82a56,56,0,0,1-79.2-79.21L147.67,35.73a40,40,0,1,1,56.61,56.55L105,193A24,24,0,1,1,71,159L154.3,74.38A8,8,0,1,1,165.7,85.6L82.39,170.31a8,8,0,1,0,11.27,11.36L192.93,81A24,24,0,1,0,159,47L59.76,147.68a40,40,0,1,0,56.53,56.62l82.06-82A8,8,0,0,1,209.66,122.34Z",
  ],
  back: [
    "M160,48V208L80,128Z",
    "M163.06,40.61a8,8,0,0,0-8.72,1.73l-80,80a8,8,0,0,0,0,11.32l80,80A8,8,0,0,0,168,208V48A8,8,0,0,0,163.06,40.61ZM152,188.69,91.31,128,152,67.31Z",
  ],
} satisfies Record<string, [string, string]>;

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  const [light, main] = ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path className="duo" d={light} />
      <path d={main} />
    </svg>
  );
}

/** A page beside the left rail, such as settings and alerts. The rail stays in use. */
export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="page" aria-label={title}>
      <header className="page-head">
        <h2>{title}</h2>
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}

/** One card on a page: a title and its help on the left, the controls on the right. */
export function PageRow({
  title,
  help,
  children,
}: {
  title: ReactNode;
  help?: string;
  children: ReactNode;
}) {
  return (
    <section className="page-row">
      <div>
        <h3>{title}</h3>
        {help !== undefined && <p className="hint">{help}</p>}
      </div>
      <div className="page-controls">{children}</div>
    </section>
  );
}

/**
 * The page for everyone who is not signed in: one card over the sky and the sea from the landing
 * page. With onSubmit, the card is a form.
 */
export function AuthPage({
  onSubmit,
  children,
}: {
  onSubmit?(event: FormEvent): void;
  children: ReactNode;
}) {
  const content = (
    <>
      <Logo />
      {children}
    </>
  );
  return (
    <div className="signin">
      <div className="sky" aria-hidden="true">
        <span className="cloud cloud-a" />
        <span className="cloud cloud-b" />
        <span className="sun" />
      </div>
      <main className="signform">
        {onSubmit === undefined ? (
          <div className="card">{content}</div>
        ) : (
          <form className="card" onSubmit={onSubmit}>
            {content}
          </form>
        )}
      </main>
      <Sea className="shore" options={SHORE} size={150} />
    </div>
  );
}
