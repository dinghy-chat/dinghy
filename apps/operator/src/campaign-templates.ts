import { PAGE_SECONDS_DEFAULT } from "../../../packages/widget/src/shared.ts";
import type { CampaignDefinition } from "./api.ts";
import { dateInput, newDefinition } from "./campaign-draft.ts";
import { TINT, type Tint } from "./campaign-tile.tsx";
import { browserTimeZone } from "./format.ts";
import type { IconName } from "./icons.tsx";
import { type TextId, t } from "./text.ts";

// The campaigns a new workspace starts from. Each makes a draft that opens in the editor, so every
// part of it can change before it goes live.

interface CampaignTemplate {
  title: TextId;
  text: TextId;
  icon: IconName;
  tint: Tint;
  definition(): CampaignDefinition;
}

/** When the announcement goes, the day after it is made. */
const ANNOUNCE_TIME = "10:00";

type Buttons = NonNullable<CampaignDefinition["message"]["buttons"]>;

/** A draft with a name, a key, a text and its buttons, and the parts a template sets. */
const draft = (
  key: string,
  { name, body, buttons }: { name: TextId; body: TextId; buttons?: Buttons },
  parts: Partial<CampaignDefinition>,
): CampaignDefinition => ({
  ...newDefinition(),
  key,
  name: t(name),
  message: { body: t(body), ...(buttons && { buttons }) },
  ...parts,
});

export const TEMPLATES: CampaignTemplate[] = [
  {
    title: "templateWelcome",
    text: "templateWelcomeText",
    icon: "smiley",
    tint: TINT.mint,
    definition: () =>
      draft(
        "welcome",
        { name: "templateWelcome", body: "templateWelcomeBody" },
        {
          audience: { field: "signedIn", op: "eq", value: true },
        },
      ),
  },
  {
    title: "templateSetup",
    text: "templateSetupText",
    icon: "clock",
    tint: TINT.yellow,
    definition: () =>
      draft(
        "setup-help",
        {
          name: "templateSetup",
          body: "templateSetupBody",
          buttons: [
            { label: t("templateYes"), value: "yes" },
            { label: t("templateNo"), dismiss: true, value: "no" },
          ],
        },
        {
          audience: { field: "attributes.setupDone", op: "ne", value: true },
          trigger: { type: "match", delay: "1d" },
          rules: {
            ...newDefinition().rules,
            exitWhen: { field: "repliedToCampaign", op: "eq", value: true },
          },
        },
      ),
  },
  {
    title: "templatePage",
    text: "templatePageText",
    icon: "question",
    tint: TINT.peach,
    definition: () =>
      draft(
        "page-help",
        { name: "templatePage", body: "templatePageBody" },
        {
          trigger: { type: "page", url: "/pricing*", seconds: PAGE_SECONDS_DEFAULT },
        },
      ),
  },
  {
    title: "templateAnnounce",
    text: "templateAnnounceText",
    icon: "megaphone",
    tint: TINT.blue,
    definition: () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      return draft(
        "announcement",
        { name: "templateAnnounce", body: "templateAnnounceBody" },
        {
          trigger: {
            type: "schedule",
            repeat: "once",
            time: ANNOUNCE_TIME,
            startDate: dateInput(tomorrow),
            timeZone: browserTimeZone(),
          },
          presentation: { ...newDefinition().presentation, show: "badge" },
        },
      );
    },
  },
];

/** `key`, or `key-2`, `key-3`… when another campaign has it. */
export function freeKey(key: string, taken: ReadonlySet<string>): string {
  let next = key;
  for (let count = 2; taken.has(next); count += 1) next = `${key}-${count}`;
  return next;
}
