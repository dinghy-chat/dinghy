/** @jsxImportSource preact */
// The operator app's preview of the Widget tab: the chat's own pieces, with sample messages, and no
// request to any server. It changes with each edit, before a save.
import { Fragment, render } from "preact";
import { useRef } from "preact/hooks";
import { LAUNCHER_CSS, LAUNCHER_ICONS, type LauncherKind, paintColors } from "./launcher.ts";
import {
  Branding,
  ChatHead,
  ChatLine,
  Composer,
  CSS,
  EmailCard,
  EmptyLog,
  emailLayout,
  type Line,
  sayer,
  startsRun,
} from "./panel.tsx";
import type { SavedAppearance, TeamFace } from "./shared.ts";

// The open panel, and under it the launcher on its side, as in the corner of a site. The panel
// stays in its box, where on a phone it would fill the screen. `.stage .panel` is as specific as
// the phone's rule, and this sheet comes after. The icon's wrapper is no box of its own.
const PREVIEW_CSS =
  ":host{display:block}.stage{display:flex;flex-direction:column;align-items:flex-end;gap:16px}:host([data-side=left]) .stage{align-items:flex-start}.stage .panel{position:relative;inset:auto;width:100%;max-width:370px;height:500px;max-height:none;border-radius:var(--dinghy-radius,var(--d-radius,16px))}.launcher i{display:contents}";

/** The sample conversation, in the operator app's words. */
interface PreviewSample {
  question: string;
  answer: string;
  /** Who answers: a member who replied lately, or the operator who looks. */
  author: TeamFace;
}

export interface PreviewProps {
  appearance: SavedAppearance;
  /** The colors the panel shows: the saved theme, or for auto, the visitor's device. */
  theme: "light" | "dark";
  sample: PreviewSample;
}

const ignore = () => {};
const preventSubmit = (event: Event) => event.preventDefault();

function sampleLines({ question, answer, author }: PreviewSample): Line[] {
  const line = { seq: null, attachment: null, status: "sent" } as const;
  return [
    { ...line, id: "question", body: question, fromVisitor: true, author: null },
    { ...line, id: "answer", body: answer, fromVisitor: false, author: { ...author, bot: false } },
  ];
}

/** A usual reply time of 2 minutes, a sample as the messages are: the real one needs a server. */
const SAMPLE_REPLY_SECONDS = 120;

/** Two members online, as a sample, so the owner sees the dots. */
const sampleOnline = ({ faces, team }: SavedAppearance) =>
  (faces.length > 0 ? faces : team).slice(0, 2).map((face) => face.id);

/** The launcher as the loader draws it. The label carries the chat's title. */
function Launcher({ kind, title }: { kind: LauncherKind; title: string }) {
  return (
    <span class={`launcher ${kind}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from launcher.ts. */}
      <i dangerouslySetInnerHTML={{ __html: LAUNCHER_ICONS[kind] }} />
      {kind === "label" && <b>{title}</b>}
    </span>
  );
}

function Preview({ appearance, sample }: PreviewProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const say = sayer(appearance);
  const { launcher, mascot, emailAsk } = appearance;
  // The sample visitor has written, unless the email comes first.
  const email = emailLayout(emailAsk, {
    mayAsk: true,
    chatted: emailAsk !== "before_first",
    known: true,
  });
  const lines = email.composer ? sampleLines(sample) : [];
  const card = (
    <EmailCard
      face={appearance.team[0] ?? null}
      lead={email.composer ? "emailAfterFirst" : "emailBeforeFirst"}
      email=""
      bad={null}
      onInput={ignore}
      onSubmit={preventSubmit}
    />
  );
  return (
    <div class="stage">
      <section class="panel">
        <ChatHead
          scene="waiting"
          online
          members={sampleOnline(appearance)}
          replySeconds={SAMPLE_REPLY_SECONDS}
          mascot={mascot}
          saved={appearance}
          say={say}
          onClose={ignore}
        />
        <div class="log">
          {lines.length === 0 && <EmptyLog mascot={mascot} greeting={say("empty")} />}
          {lines.map((line, index) => (
            <Fragment key={line.id}>
              <ChatLine
                line={line}
                showAuthor={startsRun(lines, index)}
                onView={ignore}
                onUploadError={ignore}
                onRetry={ignore}
              />
              {/* The card follows the sample visitor's message, as in the chat. */}
              {line.fromVisitor && email.form && card}
            </Fragment>
          ))}
        </div>
        {email.form && !email.composer && card}
        {email.composer && (
          <Composer
            draft=""
            inputRef={input}
            onDraft={ignore}
            onSubmit={preventSubmit}
            onFiles={ignore}
            filesAllowed={appearance.visitorFiles}
          />
        )}
        {appearance.branding && <Branding />}
      </section>
      {/* A hidden launcher draws nothing, and the operator app says so. */}
      {launcher !== "hidden" && <Launcher kind={launcher} title={say("title")} />}
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
