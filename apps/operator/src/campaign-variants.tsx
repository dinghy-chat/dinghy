/** @jsxImportSource react */
import {
  CAMPAIGN_VARIANTS_MAX,
  VARIANT_WEIGHT_MAX,
  VARIANT_WEIGHT_MIN,
} from "../../../packages/widget/src/shared.ts";
import { variantMessage } from "../../server/src/campaign-parts.ts";
import type { CampaignDefinition, Member } from "./api.ts";
import { missingLocales, replaceAt, withTranslation } from "./campaign-draft.ts";
import { AddTranslation, type Language, MessageFields } from "./campaign-message.tsx";
import { Icon } from "./icons.tsx";
import { Select } from "./popup.tsx";
import { type TextId, t } from "./text.ts";

type Variant = NonNullable<CampaignDefinition["variants"]>[number];
/** What a variant sends: the campaign's message, its own, or nothing, as the control group. */
type VariantKind = "campaign" | "own" | "control";

const VARIANTS_MIN = 2;
const VARIANT_KEYS = ["a", "b", "c", "d", "e"];
/** The shares of every variant, in percent, add up to this. */
const SHARES_TOTAL = 100;

/** `count` shares as even as whole percents allow: 34, 33 and 33 for three. */
function evenShares(count: number): number[] {
  const share = Math.floor(SHARES_TOTAL / count);
  return Array.from({ length: count }, (_, index) =>
    index < SHARES_TOTAL - share * count ? share + 1 : share,
  );
}

/** The variants, shared out evenly again after one is added or removed. */
const evenly = (variants: Variant[]) => {
  const shares = evenShares(variants.length);
  return variants.map((variant, index) => ({ ...variant, weight: shares[index] ?? 0 }));
};

const VARIANT_KINDS: { value: VariantKind; label: TextId }[] = [
  { value: "campaign", label: "variantCampaign" },
  { value: "own", label: "variantOwn" },
  { value: "control", label: "variantControl" },
];

const kindOfVariant = (variant: Variant): VariantKind =>
  "control" in variant ? "control" : "message" in variant ? "own" : "campaign";

/** A variant of a kind, with its key and weight. Its own message starts as the campaign's. */
function variantOfKind(
  kind: VariantKind,
  { key, weight }: Variant,
  base: CampaignDefinition["message"],
): Variant {
  if (kind === "control") return { key, weight, control: true };
  if (kind === "own") return { key, weight, message: base };
  return { key, weight };
}

function VariantRow({
  variant,
  definition,
  members,
  meId,
  language,
  canRemove,
  canControl,
  onLanguage,
  onChange,
}: {
  variant: Variant;
  definition: CampaignDefinition;
  members: Member[];
  meId: string | null;
  language: Language;
  canRemove: boolean;
  /** Only one variant may be the control group. */
  canControl: boolean;
  onLanguage(language: Language): void;
  onChange(variant: Variant | null): void;
}) {
  const kind = kindOfVariant(variant);
  const own = variantMessage(variant);
  const kinds = VARIANT_KINDS.filter((one) => canControl || one.value !== "control");
  return (
    <li className="variant">
      <div className="variant-head">
        <label className="variant-field variant-key">
          {t("variantKey")}
          <input
            className="mono"
            required
            value={variant.key}
            onChange={(event) => onChange({ ...variant, key: event.target.value })}
          />
        </label>
        <label className="variant-field">
          {t("variantShare")}
          <span className="percent-input">
            <input
              className="percent-box"
              type="number"
              min={VARIANT_WEIGHT_MIN}
              max={VARIANT_WEIGHT_MAX}
              required
              value={variant.weight}
              onChange={(event) => onChange({ ...variant, weight: Number(event.target.value) })}
            />
            <span className="percent-sign" aria-hidden="true">
              %
            </span>
          </span>
        </label>
        <Select<VariantKind>
          label={t("variantKind")}
          value={kind}
          choices={kinds.map((one) => ({ value: one.value, label: t(one.label) }))}
          onChange={(next) => onChange(variantOfKind(next, variant, definition.message))}
        />
        {own !== undefined && (
          <AddTranslation
            label={t("variantAddTranslation", { key: variant.key })}
            missing={missingLocales({ message: own })}
            onAdd={(locale) => {
              onChange({ ...variant, message: withTranslation(own, locale) });
              onLanguage(locale);
            }}
          />
        )}
        {canRemove && (
          <button
            type="button"
            className="round"
            aria-label={t("variantRemove", { key: variant.key })}
            onClick={() => onChange(null)}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {own !== undefined && (
        <MessageFields
          message={own}
          trigger={definition.trigger.type}
          members={members}
          meId={meId}
          language={language}
          onLanguage={onLanguage}
          onChange={(message) => onChange({ ...variant, message })}
        />
      )}
    </li>
  );
}

/** Two even variants to start a test: the campaign's message, and a copy to change. */
export const newVariants = (message: CampaignDefinition["message"]): Variant[] =>
  evenly([
    { key: "a", weight: 0 },
    { key: "b", weight: 0, message },
  ]);

/**
 * A/B variants by weight, each with the campaign's message or its own, and a control group, under
 * the message once "A/B variant" started a test.
 */
export function VariantsFields({
  definition,
  members,
  meId,
  language,
  onLanguage,
  onChange,
}: {
  definition: CampaignDefinition;
  members: Member[];
  meId: string | null;
  language: Language;
  onLanguage(language: Language): void;
  onChange(variants: Variant[] | undefined): void;
}) {
  const variants = definition.variants ?? [];
  const hasControl = variants.some((one) => "control" in one);
  const total = variants.reduce((sum, one) => sum + one.weight, 0);
  // Weights from code may add up to anything, and each still gets its part of the total.
  const sharesNote = total === SHARES_TOTAL ? "" : t("variantSharesTotal", { total });
  return (
    <div className="variants-test">
      <div className="variants-head">
        <h4>{t("campaignVariants")}</h4>
        <button type="button" className="text-button" onClick={() => onChange(undefined)}>
          {t("variantsStop")}
        </button>
      </div>
      <p className="hint">{t("variantsHelp")}</p>
      <ul className="variants">
        {variants.map((variant, index) => (
          <VariantRow
            // biome-ignore lint/suspicious/noArrayIndexKey: a key changes as it is typed, and the place does not.
            key={index}
            variant={variant}
            definition={definition}
            members={members}
            meId={meId}
            language={language}
            canRemove={variants.length > VARIANTS_MIN}
            canControl={!hasControl || "control" in variant}
            onLanguage={onLanguage}
            onChange={(next) => {
              const changed = replaceAt(variants, index, next);
              onChange(next === null ? evenly(changed) : changed);
            }}
          />
        ))}
      </ul>
      {sharesNote !== "" && (
        <p className="hint" role="status">
          {sharesNote}
        </p>
      )}
      {variants.length < CAMPAIGN_VARIANTS_MAX && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onChange(
              evenly([
                ...variants,
                {
                  key: VARIANT_KEYS.find((key) => !variants.some((one) => one.key === key)) ?? "",
                  weight: 0,
                },
              ]),
            )
          }
        >
          {t("variantAdd")}
        </button>
      )}
    </div>
  );
}
