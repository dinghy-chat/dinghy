/** @jsxImportSource react */
// Who handles a conversation: its mark in the inbox rows, and the one control that picks it.
import type { ReactNode } from "react";
import type { Conversation, Member } from "./api.ts";
import { Icon } from "./icons.tsx";
import { Select } from "./popup.tsx";
import { t } from "./text.ts";
import { Avatar } from "./ui.tsx";

/** The dropdown's values for the bot and for the team. A member's value is their ID. */
const BOT = "bot";
const TEAM = "team";

/** A bot's or the team's round mark. A person's mark is their avatar. */
export function HandlerIcon({ kind }: { kind: "bot" | "team" }) {
  return (
    <span className={`handler-mark ${kind}`} aria-hidden="true">
      <Icon name={kind === "bot" ? "robot" : "team"} size={14} />
    </span>
  );
}

/**
 * Who handles a conversation, for its inbox row: the bot, the assigned person or the team, as a mark
 * with the name for the pointer and screen readers. Null when nobody does yet.
 */
export function rowHandler(conversation: Conversation, assignee: Member | undefined): ReactNode {
  const { handler } = conversation;
  const mark =
    handler?.kind === "bot"
      ? { name: handler.name, art: <HandlerIcon kind="bot" /> }
      : assignee !== undefined
        ? {
            name: assignee.name,
            art: <Avatar name={assignee.name} pictureUrl={assignee.pictureUrl} />,
          }
        : handler?.kind === "team"
          ? { name: t("handlerTeam"), art: <HandlerIcon kind="team" /> }
          : null;
  if (mark === null) return null;
  return (
    <span className="row-handler" role="img" title={mark.name} aria-label={mark.name}>
      {mark.art}
    </span>
  );
}

/** The value the dropdown shows: the bot while it handles the chat, else the assignee or the team. */
function handlerValue(conversation: Conversation, members: Member[]): string {
  if (conversation.handler?.kind === "bot") return BOT;
  const assignee = conversation.assigneeOperatorId;
  return members.some((member) => member.id === assignee) && assignee !== null ? assignee : TEAM;
}

/**
 * The one control for who handles a conversation: the bot that took part last, the team, or a
 * member. Picking the bot gives the chat back to it, and picking the team or a person takes it over.
 */
export function HandlerSelect({
  conversation,
  members,
  meId,
  side = "start",
  onAssign,
  onGiveBack,
}: {
  conversation: Conversation;
  members: Member[];
  meId: string;
  side?: "start" | "end";
  onAssign(operatorId: string | null): void;
  onGiveBack(): void;
}) {
  const { bot } = conversation;
  // Groups only help when the bot stands apart from the people.
  const people = bot === null ? undefined : t("handlerGroupPeople");
  return (
    <Select
      label={t("handlerLabel")}
      className="assignee"
      side={side}
      value={handlerValue(conversation, members)}
      choices={[
        ...(bot === null
          ? []
          : [
              {
                value: BOT,
                label: bot.name,
                lead: <HandlerIcon kind="bot" />,
                detail: t("handlerBotDetail"),
                group: t("handlerGroupBot"),
              },
            ]),
        {
          value: TEAM,
          label: t("handlerTeam"),
          lead: <HandlerIcon kind="team" />,
          detail: t("handlerTeamDetail"),
          ...(people === undefined ? {} : { group: people }),
        },
        ...members.map((member) => ({
          value: member.id,
          label: member.name,
          lead: <Avatar name={member.name} pictureUrl={member.pictureUrl} />,
          ...(member.id === meId ? { detail: t("you") } : {}),
          ...(people === undefined ? {} : { group: people }),
        })),
      ]}
      onChange={(value) => {
        if (value === BOT) onGiveBack();
        else onAssign(value === TEAM ? null : value);
      }}
    />
  );
}
