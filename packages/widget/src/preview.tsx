/** @jsxImportSource preact */
// The operator app's preview of the Widget tab: the chat's own pieces, with sample messages, and no
// request to any server. It changes with each edit, before a save.
import { render } from "preact";
import { useRef } from "preact/hooks";
import { LAUNCHER_CSS, LAUNCHER_ICONS, textOn } from "./launcher.ts";
import {
  Branding,
  ChatHead,
  ChatLine,
  Composer,
  CSS,
  EmailForm,
  EmptyLog,
  type Line,
  sayer,
  startsRun,
} from "./panel.tsx";
import type { SavedAppearance, TeamFace } from "./shared.ts";

// The panel stays in its box, where on a phone it would fill the screen, and the launcher keeps
// to its side.
const PREVIEW_CSS =
  ":host{display:block}.stage{display:flex;justify-content:flex-end;align-items:flex-end;min-height:120px}:host([data-side=left]) .stage{justify-content:flex-start}.stage .panel{position:relative!important;inset:auto!important;width:100%!important;max-width:370px!important;height:520px!important;max-height:none!important;border-radius:var(--dinghy-radius,var(--d-radius,16px))!important}";

/** The sample conversation, in the operator app's words. */
interface PreviewSample {
  question: string;
  answer: string;
  /** Who answers: a member who replied lately, or the operator who looks. */
  author: TeamFace;
}

export interface PreviewProps {
  appearance: SavedAppearance;
  open: boolean;
  dark: boolean;
  sample: PreviewSample;
}

const ignore = () => {};
const keep = (event: Event) => event.preventDefault();

function sampleLines({ question, answer, author }: PreviewSample): Line[] {
  const line = { seq: null, image: null, status: "sent" } as const;
  return [
    { ...line, id: "question", body: question, fromVisitor: true, author: null },
    { ...line, id: "answer", body: answer, fromVisitor: false, author: { ...author, bot: false } },
  ];
}

function Preview({ appearance, open, sample }: PreviewProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const say = sayer(appearance);
  const { launcher, mascot, emailAsk } = appearance;
  // A hidden launcher draws nothing, and the operator app says so.
  if (!open) {
    return (
      <div class="stage">
        {launcher !== "hidden" && (
          <span
            class={`launcher ${launcher}`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from launcher.ts.
            dangerouslySetInnerHTML={{ __html: LAUNCHER_ICONS[launcher] }}
          />
        )}
      </div>
    );
  }
  // Before the first message, the email takes the message box's place.
  const emailFirst = emailAsk === "before_first";
  const lines = emailFirst ? [] : sampleLines(sample);
  return (
    <div class="stage">
      <section class="panel">
        <ChatHead
          scene="waiting"
          online
          mascot={mascot}
          logoUrl={appearance.logoUrl}
          team={appearance.team}
          say={say}
          onClose={ignore}
        />
        <div class="log">
          {emailFirst && <EmptyLog mascot={mascot} greeting={say("empty")} />}
          {lines.map((line, index) => (
            <ChatLine
              key={line.id}
              line={line}
              showAuthor={startsRun(lines, index)}
              onView={ignore}
              onImageError={ignore}
              onRetry={ignore}
            />
          ))}
        </div>
        {emailAsk !== "off" && <EmailForm email="" bad={null} onInput={ignore} onSubmit={keep} />}
        {!emailFirst && (
          <Composer draft="" inputRef={input} onDraft={ignore} onSubmit={keep} onFiles={ignore} />
        )}
        {appearance.branding && <Branding />}
      </section>
    </div>
  );
}

/** Sets a color and the text that reads on it, or leaves the widget's own. */
function paintColor(host: HTMLElement, name: "primary" | "accent", color: string | null) {
  for (const [property, value] of [
    [`--d-${name}`, color],
    [`--d-${name}-text`, color === null ? null : textOn(color)],
  ] as const) {
    if (value === null) host.style.removeProperty(property);
    else host.style.setProperty(property, value);
  }
}

/** Draws the preview in `shadow`, again on each call. */
export function renderPreview(shadow: ShadowRoot, props: PreviewProps): void {
  if (shadow.adoptedStyleSheets.length === 0) {
    shadow.adoptedStyleSheets = [CSS, LAUNCHER_CSS, PREVIEW_CSS].map((text) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      return sheet;
    });
  }
  const host = shadow.host as HTMLElement;
  const { appearance } = props;
  paintColor(host, "primary", appearance.primary);
  paintColor(host, "accent", appearance.accent);
  host.style.setProperty("--d-radius", `${appearance.radius}px`);
  host.setAttribute("data-side", appearance.position);
  host.setAttribute("data-theme", props.dark ? "dark" : "light");
  render(<Preview {...props} />, shadow);
}
