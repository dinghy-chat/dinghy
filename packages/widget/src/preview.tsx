/** @jsxImportSource preact */
// The operator app's preview of the Widget tab: the chat's own pieces, with sample messages, and no
// request to any server. It changes with each edit, before a save.
import { render } from "preact";
import { useRef } from "preact/hooks";
import { LAUNCHER_CSS, LAUNCHER_ICONS, paintColors } from "./launcher.ts";
import {
  Branding,
  ChatHead,
  ChatLine,
  Composer,
  CSS,
  EmailForm,
  EmptyLog,
  emailLayout,
  type Line,
  sayer,
  startsRun,
} from "./panel.tsx";
import type { SavedAppearance, TeamFace } from "./shared.ts";

// The panel stays in its box, where on a phone it would fill the screen, and the launcher keeps
// to its side. `.stage .panel` is as specific as the phone's rule, and this sheet comes after.
const PREVIEW_CSS =
  ":host{display:block}.stage{display:flex;justify-content:flex-end;align-items:flex-end;min-height:120px}:host([data-side=left]) .stage{justify-content:flex-start}.stage .panel{position:relative;inset:auto;width:100%;max-width:370px;height:520px;max-height:none;border-radius:var(--dinghy-radius,var(--d-radius,16px))}";

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
  /** The colors the panel shows: the saved theme, or for auto, the visitor's device. */
  theme: "light" | "dark";
  sample: PreviewSample;
}

const ignore = () => {};
const preventSubmit = (event: Event) => event.preventDefault();

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
  // The sample visitor has written, unless the email comes first.
  const email = emailLayout(emailAsk, {
    mayAsk: true,
    chatted: emailAsk !== "before_first",
    known: true,
  });
  const lines = email.composer ? sampleLines(sample) : [];
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
          {lines.length === 0 && <EmptyLog mascot={mascot} greeting={say("empty")} />}
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
        {email.form && <EmailForm email="" bad={null} onInput={ignore} onSubmit={preventSubmit} />}
        {email.composer && (
          <Composer
            draft=""
            inputRef={input}
            onDraft={ignore}
            onSubmit={preventSubmit}
            onFiles={ignore}
          />
        )}
        {appearance.branding && <Branding />}
      </section>
    </div>
  );
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
  paintColors(host.style, appearance);
  host.style.setProperty("--d-radius", `${appearance.radius}px`);
  host.setAttribute("data-side", appearance.position);
  host.setAttribute("data-theme", props.theme);
  render(<Preview {...props} />, shadow);
}

/** Removes the preview from `shadow`, which stops its animations. */
export function clearPreview(shadow: ShadowRoot): void {
  render(null, shadow);
}
