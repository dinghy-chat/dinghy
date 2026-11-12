/** @jsxImportSource react */
import { createElement } from "react";
import { renderMarkdown } from "../../../packages/widget/src/markdown.ts";
import type { Member } from "./api.ts";
import { clockTime } from "./format.ts";
import { HandlerIcon } from "./handler.tsx";
import { Icon } from "./icons.tsx";
import { t } from "./text.ts";
import { plainLinks } from "./thread-line.tsx";
import type { Line } from "./thread-lines.ts";
import { Avatar } from "./ui.tsx";

/**
 * A bot handed the conversation to people: one centered line with who took it and when, and the
 * bot's note under it, which only the team sees.
 */
export function HandoffNote({
  line,
  meId,
  members,
}: {
  line: Line;
  meId: string;
  members: Member[];
}) {
  const to = line.handoff?.operatorId ?? null;
  const person = members.find((member) => member.id === to);
  const target =
    to === null
      ? t("handoffToTeam")
      : to === meId
        ? t("handoffToYou")
        : (person?.name ?? t("aTeammate"));
  return (
    <div className="handoff">
      <p className="handoff-line">
        <span className="handoff-pill">
          <span className="handoff-pass" aria-hidden="true">
            <HandlerIcon kind="bot" />
            {person === undefined ? (
              <HandlerIcon kind="team" />
            ) : (
              <Avatar name={person.name} pictureUrl={person.pictureUrl} />
            )}
          </span>
          <b>{line.authorName ?? t("aBot")}</b> {t("handoffTo", { to: target })}
          {line.createdAt !== undefined && (
            <time className="handoff-time" dateTime={line.createdAt}>
              {clockTime(line.createdAt)}
            </time>
          )}
        </span>
      </p>
      <section className="handoff-card" aria-label={t("handoffNote")}>
        <header>
          <h4>{t("handoffNote")}</h4>
          <span className="handoff-private">
            <Icon name="eyeOff" size={13} />
            {t("handoffPrivate")}
          </span>
        </header>
        {createElement(
          "div",
          { className: "handoff-text" },
          ...renderMarkdown(line.body, plainLinks),
        )}
      </section>
    </div>
  );
}
