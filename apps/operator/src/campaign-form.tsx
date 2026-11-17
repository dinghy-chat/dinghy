/** @jsxImportSource react */
import type { CampaignDefinition, CampaignEstimate, Member, WorkspaceApi } from "./api.ts";
import { missingLocales, withLanguage, withPart } from "./campaign-draft.ts";
import { AddTranslation, type Language, MessageFields } from "./campaign-message.tsx";
import { DeliveryFields, GoalFields, RulesFields, ShowCards } from "./campaign-rules.tsx";
import { Fold, Step } from "./campaign-steps.tsx";
import { deliveryWords, goalWords, peopleWords, rulesWords } from "./campaign-summary.ts";
import { TriggerFields } from "./campaign-trigger.tsx";
import { newVariants, VariantsFields } from "./campaign-variants.tsx";
import { ConditionBuilder, NameLists } from "./condition-builder.tsx";
import { Icon } from "./icons.tsx";
import { type Loaded, useLoad, useSettled } from "./load.ts";
import { t } from "./text.ts";

type Estimate = Loaded<CampaignEstimate>;

/** How many people the audience and the trigger reach, once the editor stops changing them. */
function useEstimate(api: WorkspaceApi, definition: CampaignDefinition): Estimate {
  const choice = JSON.stringify({ audience: definition.audience, trigger: definition.trigger });
  const settled = useSettled(choice);
  return useLoad(
    () =>
      api.estimateCampaign(JSON.parse(settled) as Parameters<WorkspaceApi["estimateCampaign"]>[0]),
    [api, settled],
  );
}

/** "3 people now", in the audience's header. */
function MatchingBadge({ estimate }: { estimate: Estimate }) {
  if (estimate.data === null) return null;
  return (
    <span className="count-badge" role="status">
      {t("campaignMatchingNow", { people: peopleWords(estimate.data.matching) })}
    </span>
  );
}

/** "Would have reached 3 people in the last 7 days", under the trigger. */
function LastWeekLine({ estimate }: { estimate: Estimate }) {
  if (estimate.failure !== null) return <p className="hint">{t("campaignEstimateWaiting")}</p>;
  const lastWeek = estimate.data?.lastWeek ?? null;
  if (lastWeek === null) return null;
  return (
    <p className="hint" role="status">
      {t("campaignLastWeek", { people: peopleWords(lastWeek) })}
    </p>
  );
}

/** "+ Translation" and "+ A/B variant", in the message's header. */
function MessageAdds({
  definition,
  onLanguage,
  onChange,
}: {
  definition: CampaignDefinition;
  onLanguage(language: Language): void;
  onChange(definition: CampaignDefinition): void;
}) {
  return (
    <>
      <AddTranslation
        label={t("campaignAddTranslation")}
        missing={missingLocales(definition)}
        onAdd={(locale) => {
          onChange(withLanguage(definition, locale));
          onLanguage(locale);
        }}
      />
      {definition.variants === undefined && (
        <button
          type="button"
          className="text-button"
          onClick={() => onChange({ ...definition, variants: newVariants(definition.message) })}
        >
          <Icon name="plus" size={14} />
          {t("campaignAddVariant")}
        </button>
      )}
    </>
  );
}

/**
 * The editor's cards: who gets it, when it goes, the message and how it shows, then the rules, the
 * goal and the delivery folded to one line each.
 */
export function CampaignSteps({
  api,
  definition,
  members,
  language,
  onLanguage,
  onChange,
}: {
  api: WorkspaceApi;
  definition: CampaignDefinition;
  members: Member[];
  language: Language;
  onLanguage(language: Language): void;
  onChange(definition: CampaignDefinition): void;
}) {
  const estimate = useEstimate(api, definition);
  const change = <K extends keyof CampaignDefinition>(key: K, value: CampaignDefinition[K]) =>
    onChange(withPart(definition, key, value));
  const isPage = definition.trigger.type === "page";
  return (
    <div className="campaign-steps">
      <NameLists api={api} />
      <Step number={1} title={t("stepWho")} aside={<MatchingBadge estimate={estimate} />}>
        <ConditionBuilder
          initial={definition.audience}
          emptyText="campaignAudienceEveryone"
          onChange={(audience) => change("audience", audience)}
        />
      </Step>
      <Step number={2} title={t("stepWhen")}>
        <TriggerFields
          trigger={definition.trigger}
          campaignKey={definition.key}
          onChange={(trigger) => change("trigger", trigger)}
        />
        <LastWeekLine estimate={estimate} />
      </Step>
      <Step
        number={3}
        title={t("stepMessage")}
        aside={<MessageAdds definition={definition} onLanguage={onLanguage} onChange={onChange} />}
      >
        <MessageFields
          message={definition.message}
          trigger={definition.trigger.type}
          members={members}
          language={language}
          onLanguage={onLanguage}
          onChange={(message) => change("message", message)}
        />
        {definition.variants !== undefined && (
          <VariantsFields
            definition={definition}
            members={members}
            language={language}
            onLanguage={onLanguage}
            onChange={(variants) => change("variants", variants)}
          />
        )}
      </Step>
      <Step number={4} title={t("stepShow")}>
        <ShowCards
          show={definition.presentation.show}
          isPage={isPage}
          onChange={(show) => change("presentation", { ...definition.presentation, show })}
        />
      </Step>
      <Fold title={t("campaignRules")} summary={rulesWords(definition.rules)}>
        <RulesFields rules={definition.rules} onRules={(rules) => change("rules", rules)} />
      </Fold>
      <Fold title={t("campaignGoal")} summary={goalWords(definition.rules.goal)}>
        <GoalFields
          goal={definition.rules.goal}
          onChange={(goal) => change("rules", withPart(definition.rules, "goal", goal))}
        />
      </Fold>
      <Fold title={t("campaignDelivery")} summary={deliveryWords(definition)}>
        <DeliveryFields
          presentation={definition.presentation}
          delivery={definition.delivery}
          isPage={isPage}
          onPresentation={(presentation) => change("presentation", presentation)}
          onChange={(delivery) => change("delivery", delivery)}
        />
      </Fold>
    </div>
  );
}
