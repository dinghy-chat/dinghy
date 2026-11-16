/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { CampaignDefinition, Member } from "./api.ts";
import { type Language, messageIn } from "./campaign-message.tsx";
import { Step } from "./campaign-steps.tsx";
import {
  asLine,
  deliveryWords,
  goalWords,
  rulesWords,
  showWords,
  triggerWords,
  whoWords,
} from "./campaign-summary.ts";
import { t } from "./text.ts";

// A campaign read, not edited: what an ended campaign sent, or what a member who can't edit sees.
// Each part is a sentence, so nothing on the page looks like a field to change.

type Message = CampaignDefinition["message"];

/** Who it comes from, as the editor's sender list names them. */
function senderWords(sender: Message["sender"], members: Member[]): string {
  if (sender === undefined) return t("senderAuthor");
  if (sender === "team") return t("outboundTeam");
  const member = members.find((one) =>
    "operatorId" in sender ? one.id === sender.operatorId : one.email === sender.email,
  );
  if (member !== undefined) return member.name;
  return "email" in sender ? sender.email : t("overviewSenderGone");
}

/** A message's sender, text and buttons, in the language the preview shows. */
function MessageText({
  message,
  members,
  language,
}: {
  message: Message;
  members: Member[];
  language: Language;
}) {
  const { body, buttons } = messageIn(message, language);
  return (
    <div className="overview-message">
      <p className="step-summary">
        {t("overviewFrom", { sender: senderWords(message.sender, members) })}
      </p>
      <p className="overview-body">{body}</p>
      {buttons.length > 0 && (
        <p className="overview-buttons">
          {buttons.map((button) => (
            <span key={button.label} className="chip">
              {button.label}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** One line of a part, as a step's body. */
const Line = ({ children }: { children: ReactNode }) => <p className="overview-line">{children}</p>;

export function CampaignOverview({
  definition,
  members,
  language,
}: {
  definition: CampaignDefinition;
  members: Member[];
  language: Language;
}) {
  const { audience, trigger, message, variants, presentation, rules } = definition;
  const total = variants?.reduce((sum, variant) => sum + variant.weight, 0) ?? 0;
  return (
    <div className="campaign-steps">
      <Step number={1} title={t("stepWho")}>
        <Line>{whoWords(audience)}</Line>
      </Step>
      <Step number={2} title={t("stepWhen")}>
        <Line>{asLine(triggerWords(trigger))}</Line>
      </Step>
      <Step number={3} title={t("stepMessage")}>
        {variants === undefined ? (
          <MessageText message={message} members={members} language={language} />
        ) : (
          variants.map((variant) => (
            <section key={variant.key} className="overview-variant">
              <h4>
                {t("overviewVariant", {
                  key: variant.key,
                  share: Math.round((variant.weight / total) * 100),
                })}
              </h4>
              {"control" in variant ? (
                <Line>{t("variantControl")}</Line>
              ) : (
                <MessageText
                  message={variant.message ?? message}
                  members={members}
                  language={language}
                />
              )}
            </section>
          ))
        )}
      </Step>
      <Step number={4} title={t("stepShow")}>
        <Line>{asLine(showWords(presentation))}</Line>
      </Step>
      <Step number={5} title={t("campaignRules")}>
        <Line>{rulesWords(rules)}</Line>
      </Step>
      <Step number={6} title={t("campaignGoal")}>
        <Line>{goalWords(rules.goal)}</Line>
      </Step>
      <Step number={7} title={t("campaignDelivery")}>
        <Line>{deliveryWords(definition)}</Line>
      </Step>
    </div>
  );
}
