/** @jsxImportSource react */
import { useState } from "react";
import { pickLocale } from "../../../packages/widget/src/locale.ts";
import {
  firstName,
  LOCALES,
  type OutboundButton,
  type TeamFace,
} from "../../../packages/widget/src/shared.ts";
import type { CampaignDefinition, Me, Member, OperatorAppearance } from "./api.ts";
import { type Language, LOCALE_TEXT, messageIn } from "./campaign-message.tsx";
import { t } from "./text.ts";
import { Choices, type Option } from "./ui.tsx";
import { PreviewFrame, WidgetDrawing } from "./widget-drawing.tsx";

type Device = "desktop" | "phone";

const THEMES: Option<"light" | "dark">[] = [
  { value: "light", label: "themeLight", icon: "sun" },
  { value: "dark", label: "themeDark", icon: "moon" },
];
const DEVICES: Option<Device>[] = [
  { value: "desktop", label: "previewDesktop" },
  { value: "phone", label: "previewPhone" },
];

/** Who the visitor sees as the sender: the team, a member, or the member who saves it. */
function senderFace(
  sender: CampaignDefinition["message"]["sender"],
  { me, members, workspace }: { me: Me; members: Member[]; workspace: TeamFace },
): TeamFace {
  if (sender === "team") return workspace;
  const member =
    sender === undefined
      ? undefined
      : members.find((one) =>
          "operatorId" in sender ? one.id === sender.operatorId : one.email === sender.email,
        );
  const face = member ?? me;
  return { id: face.id, name: firstName(face.name), pictureUrl: face.pictureUrl };
}

/**
 * The campaign's message as the widget shows it, beside the form: in light or dark, in each of its
 * languages, and at a phone's width, where a message for the open chat shows as a card.
 */
export function CampaignPreview({
  definition,
  appearance,
  me,
  members,
  workspace,
  language,
  onLanguage,
}: {
  definition: CampaignDefinition;
  appearance: OperatorAppearance;
  me: Me;
  members: Member[];
  /** The workspace's name and logo, for a message from the team. */
  workspace: TeamFace;
  language: Language;
  onLanguage(language: Language): void;
}) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [device, setDevice] = useState<Device>("desktop");
  const { message, presentation } = definition;
  const translated = LOCALES.filter((one) => message.translations?.[one] !== undefined);
  const { body, buttons } = messageIn(message, language);
  const show = device === "phone" && presentation.show === "chat" ? "preview" : presentation.show;
  return (
    <PreviewFrame
      controls={
        <div className="preview-controls">
          <Choices<"light" | "dark">
            label={t("previewTheme")}
            value={theme}
            options={THEMES}
            onChange={setTheme}
          />
          <Choices<Device>
            label={t("previewScreen")}
            value={device}
            options={DEVICES}
            onChange={setDevice}
          />
          {translated.length > 0 && (
            <Choices<Language>
              label={t("campaignLanguages")}
              value={language}
              options={[
                { value: "default", label: "campaignDefaultLanguage" },
                ...translated.map((one) => ({ value: one, label: LOCALE_TEXT[one] })),
              ]}
              onChange={onLanguage}
            />
          )}
        </div>
      }
    >
      <div className={device === "phone" ? "preview-phone" : undefined}>
        <WidgetDrawing
          locale={
            language === "default"
              ? pickLocale(undefined, appearance.language, navigator.languages)
              : language
          }
          appearance={appearance}
          theme={theme}
          // The message shows in place of the sample conversation.
          sample={{ question: "", answer: "", author: workspace }}
          outbound={{
            body: body === "" ? t("campaignPreviewEmpty") : body,
            // The same buttons: the server's type spells the kinds another way.
            buttons: buttons as OutboundButton[],
            show,
            author: senderFace(message.sender, { me, members, workspace }),
          }}
        />
      </div>
    </PreviewFrame>
  );
}
