/** @jsxImportSource react */
import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { TeamFace } from "../../../packages/widget/src/shared.ts";
import {
  ApiError,
  type Campaign,
  type CampaignDefinition,
  type CampaignEstimate,
  type Me,
  type Member,
  type OutboundStatusReason,
  type WorkspaceApi,
} from "./api.ts";
import { FormSection, LeaveGuard } from "./appearance.tsx";
import {
  definitionJson,
  keyFromName,
  newDefinition,
  upsertCode,
  withPart,
} from "./campaign-draft.ts";
import { type Language, MessageFields } from "./campaign-message.tsx";
import { CampaignPreview } from "./campaign-preview.tsx";
import { CampaignResultsView } from "./campaign-results.tsx";
import { DeliveryFields, PresentationFields, RulesFields } from "./campaign-rules.tsx";
import { sendCode, TriggerFields } from "./campaign-trigger.tsx";
import { VariantsFields } from "./campaign-variants.tsx";
import { ConditionBuilder } from "./condition-builder.tsx";
import { Icon } from "./icons.tsx";
import { CodeBlock } from "./install.tsx";
import { useLoad, useSettled } from "./load.ts";
import { reasonText } from "./outbound.tsx";
import { Confirm, Menu, type MenuItem } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Choices, ErrorNote, Field, failureText, Loading, Modal, PageHead } from "./ui.tsx";

export const STATUS_TEXT: Record<Campaign["status"], TextId> = {
  draft: "campaignDraft",
  live: "campaignLive",
  paused: "campaignPaused",
  ended: "campaignEnded",
};

/** A status as a chip: live stands out, a pause warns. */
export function StatusChip({ status }: { status: Campaign["status"] }) {
  const tone = status === "live" ? " campaign-live" : status === "paused" ? " warn" : "";
  return <span className={`chip${tone}`}>{t(STATUS_TEXT[status])}</span>;
}

/**
 * Why a save or an action failed. The editor checks the text's variables itself, so a definition
 * the server still refuses gets one general line.
 */
function campaignFailure(error: unknown): TextId {
  if (error instanceof ApiError) {
    if (error.code === "invalid_request") return "campaignInvalid";
    if (error.code === "campaign_key_taken") return "campaignKeyTaken";
    if (error.code === "campaign_ended") return "campaignEndedRefused";
  }
  return failureText(error, { 403: "campaignForbidden" }, "actionFailed");
}

/** "1,204 people", or "10,000+ people" past the count's limit. */
const reachText = ({ count, more }: { count: number; more: boolean }) =>
  t(count === 1 && !more ? "campaignPeopleOne" : "campaignPeopleMany", {
    count: `${count.toLocaleString()}${more ? "+" : ""}`,
  });

/** How many people the audience and the trigger reach, as the editor changes them. */
function useEstimate(api: WorkspaceApi, definition: CampaignDefinition) {
  const choice = JSON.stringify({ audience: definition.audience, trigger: definition.trigger });
  const settled = useSettled(choice);
  return useLoad(
    () =>
      api.estimateCampaign(JSON.parse(settled) as Parameters<WorkspaceApi["estimateCampaign"]>[0]),
    [api, settled],
  );
}

function EstimateLine({
  estimate,
  pick,
  text,
}: {
  estimate: { data: CampaignEstimate | null; failure: TextId | null };
  pick(estimate: CampaignEstimate): CampaignEstimate["lastWeek"];
  text: TextId;
}) {
  if (estimate.failure !== null) return <p className="hint">{t("campaignEstimateWaiting")}</p>;
  const reach = estimate.data === null ? null : pick(estimate.data);
  if (reach === null) return null;
  return (
    <p className="estimate" role="status">
      {t(text, { people: reachText(reach) })}
    </p>
  );
}

/** "Copy as code": the JSON, and the SDK calls that keep it in a repository and send it. */
function CodeDialog({ definition, onClose }: { definition: CampaignDefinition; onClose(): void }) {
  const [shown, setShown] = useState<"json" | "sdk">("json");
  const titleId = useId();
  const sdk =
    definition.trigger.type === "api"
      ? `${upsertCode(definition)}\n\n${sendCode(definition.key)}`
      : upsertCode(definition);
  return (
    <Modal className="dialog code-dialog" labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <h2 id={titleId}>{t("campaignCode")}</h2>
          <p className="dialog-text">{t("campaignCodeHelp")}</p>
          <Choices<"json" | "sdk">
            label={t("campaignCode")}
            variant="tabs"
            value={shown}
            options={[
              { value: "json", label: "campaignCodeJson" },
              { value: "sdk", label: "campaignCodeSdk" },
            ]}
            onChange={setShown}
          />
          {shown === "json" ? (
            <CodeBlock value={definitionJson(definition)} language="json" title="JSON" />
          ) : (
            <CodeBlock value={sdk} language="ts" title="@dinghy-chat/sdk" />
          )}
          <div className="dialog-actions">
            <button type="button" className="pill dark" onClick={close}>
              {t("done")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** What "Send a test to me" did, and the rule that would hold a real message now. */
function TestDialog({
  blockedBy,
  conversationId,
  onOpenConversation,
  onClose,
}: {
  blockedBy: OutboundStatusReason | null;
  conversationId: string | null;
  onOpenConversation(id: string): void;
  onClose(): void;
}) {
  const titleId = useId();
  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      {(close) => (
        <div className="dialog-body">
          <h2 id={titleId}>{t("campaignTestSent")}</h2>
          <p className="dialog-text">{t("campaignTestSentHelp")}</p>
          <p className="note" role="status">
            {blockedBy === null
              ? t("campaignTestClear")
              : t("campaignTestBlocked", { rule: reasonText(blockedBy) })}
          </p>
          <div className="dialog-actions">
            <button type="button" className="pill" onClick={close}>
              {t("close")}
            </button>
            {conversationId !== null && (
              <button
                type="button"
                className="pill dark"
                onClick={() => onOpenConversation(conversationId)}
              >
                {t("contactOpenConversation")}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The parts "More options" holds, which a new campaign leaves at their defaults. */
const MORE_PARTS = ["variants", "presentation", "delivery", "rules"] as const;

/** Whether the campaign changes one of the parts under "More options", so it opens on them. */
const changesMore = (definition: CampaignDefinition) => {
  const defaults = newDefinition();
  return MORE_PARTS.some(
    (part) => JSON.stringify(definition[part]) !== JSON.stringify(defaults[part]),
  );
};

interface SectionProps {
  definition: CampaignDefinition;
  members: Member[];
  language: Language;
  onLanguage(language: Language): void;
  onChange(definition: CampaignDefinition): void;
}

/** The sections everyone needs: the name, who it is for, when it goes, and what it says. */
function MainSections({
  api,
  definition,
  isNew,
  members,
  language,
  onLanguage,
  onChange,
}: SectionProps & { api: WorkspaceApi; isNew: boolean }) {
  const estimate = useEstimate(api, definition);
  const change = <K extends keyof CampaignDefinition>(key: K, value: CampaignDefinition[K]) =>
    onChange(withPart(definition, key, value));
  // A new campaign's key follows its name until someone types one.
  const [keyTyped, setKeyTyped] = useState(!isNew);
  return (
    <>
      <FormSection title="campaignNameTitle">
        <div className="field-row">
          <Field
            label={t("campaignName")}
            required
            maxLength={100}
            value={definition.name}
            onChange={(name) =>
              onChange({ ...definition, name, ...(!keyTyped && { key: keyFromName(name) }) })
            }
          />
          <Field
            label={t("campaignKey")}
            hint={t(isNew ? "campaignKeyHelp" : "campaignKeyFixed")}
            className="mono"
            required
            readOnly={!isNew}
            pattern="[a-z0-9][a-z0-9_\-]{0,63}"
            value={definition.key}
            onChange={(key) => {
              setKeyTyped(true);
              change("key", key);
            }}
          />
        </div>
      </FormSection>
      <FormSection title="campaignAudience" help="campaignAudienceHelp">
        <ConditionBuilder
          initial={definition.audience}
          emptyText="campaignAudienceEveryone"
          onChange={(audience) => change("audience", audience)}
        />
        <EstimateLine estimate={estimate} pick={(one) => one.matching} text="campaignMatchingNow" />
      </FormSection>
      <FormSection title="campaignTrigger" help="campaignTriggerHelp">
        <TriggerFields
          trigger={definition.trigger}
          campaignKey={definition.key}
          onChange={(trigger) => change("trigger", trigger)}
        />
        <EstimateLine estimate={estimate} pick={(one) => one.lastWeek} text="campaignLastWeek" />
      </FormSection>
      <FormSection title="campaignMessage" help="campaignMessageHelp">
        <MessageFields
          message={definition.message}
          trigger={definition.trigger.type}
          members={members}
          language={language}
          onLanguage={onLanguage}
          onChange={(message) => change("message", message)}
        />
      </FormSection>
    </>
  );
}

/** The advanced sections: A/B variants, how it shows, how it is delivered, and its rules. */
function MoreSections({ definition, members, language, onLanguage, onChange }: SectionProps) {
  const change = <K extends keyof CampaignDefinition>(key: K, value: CampaignDefinition[K]) =>
    onChange(withPart(definition, key, value));
  return (
    <>
      <FormSection title="campaignVariants">
        <VariantsFields
          definition={definition}
          members={members}
          language={language}
          onLanguage={onLanguage}
          onChange={(variants) => change("variants", variants)}
        />
      </FormSection>
      <FormSection title="campaignPresentation">
        <PresentationFields
          presentation={definition.presentation}
          isPage={definition.trigger.type === "page"}
          onChange={(presentation) => change("presentation", presentation)}
        />
      </FormSection>
      <FormSection title="campaignDelivery">
        <DeliveryFields
          delivery={definition.delivery}
          onChange={(delivery) => change("delivery", delivery)}
        />
      </FormSection>
      <FormSection title="campaignRules" help="campaignRulesHelp">
        <RulesFields rules={definition.rules} onRules={(rules) => change("rules", rules)} />
      </FormSection>
    </>
  );
}

/**
 * The editor's form: the main sections open, and the others under "More options", which starts
 * open when the campaign changes one of them. Its button stays usable for a member, who reads.
 */
function CampaignForm({
  api,
  formId,
  editable,
  isNew,
  onSubmit,
  children,
  ...props
}: SectionProps & {
  api: WorkspaceApi;
  formId: string;
  editable: boolean;
  isNew: boolean;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  /** The notes above the sections. */
  children: ReactNode;
}) {
  const [more, setMore] = useState(() => changesMore(props.definition));
  const moreId = useId();
  return (
    <form id={formId} className="widget-form" onSubmit={onSubmit}>
      {children}
      <fieldset className="widget-sections" disabled={!editable}>
        <MainSections api={api} isNew={isNew} {...props} />
      </fieldset>
      <button
        type="button"
        className="more-options"
        aria-expanded={more}
        aria-controls={moreId}
        onClick={() => setMore(!more)}
      >
        <Icon name="chevron" size={14} />
        {t("campaignMoreOptions")}
      </button>
      {more && (
        <fieldset id={moreId} className="widget-sections" disabled={!editable}>
          <MoreSections {...props} />
        </fieldset>
      )}
    </form>
  );
}

type Action = "save" | "live" | "pause" | "resume" | "end";

/** The page's buttons for the campaign's status: save, go live, pause, resume, and end in a menu. */
function EditorActions({
  campaign,
  canEdit,
  unsaved,
  busy,
  formId,
  onAction,
  onTest,
  onCode,
}: {
  campaign: Campaign | null;
  canEdit: boolean;
  unsaved: boolean;
  busy: boolean;
  formId: string;
  onAction(action: Action): void;
  onTest(): void;
  onCode(): void;
}) {
  const status = campaign?.status ?? "draft";
  const submit = (action: Action, label: TextId, dark = false): ReactNode => (
    <button
      type="submit"
      form={formId}
      value={action}
      className={dark ? "pill dark" : "pill"}
      disabled={busy || (action === "save" && campaign !== null && !unsaved)}
    >
      {t(label)}
    </button>
  );
  const editable = canEdit && status !== "ended";
  const items: MenuItem[] = [
    { label: t("campaignCode"), lead: <Icon name="code" size={18} />, onSelect: onCode },
  ];
  if (editable && campaign !== null) {
    items.push({
      label: t("campaignEnd"),
      lead: <Icon name="prohibit" size={18} />,
      danger: true,
      divider: true,
      onSelect: () => onAction("end"),
    });
  }
  return (
    <>
      {campaign !== null && (
        <button
          type="button"
          className="pill"
          disabled={busy || unsaved || status === "ended"}
          title={unsaved ? t("campaignTestSaveFirst") : undefined}
          onClick={onTest}
        >
          <Icon name="flask" size={18} />
          {t("campaignTest")}
        </button>
      )}
      {editable && submit("save", status === "draft" ? "campaignSaveDraft" : "save")}
      {editable && status === "draft" && submit("live", "campaignGoLive", true)}
      {editable && status === "paused" && submit("resume", "campaignResume", true)}
      {editable && status === "live" && (
        <button type="button" className="pill" disabled={busy} onClick={() => onAction("pause")}>
          <Icon name="pause" size={18} />
          {t("campaignPause")}
        </button>
      )}
      <Menu label={t("moreActions")} buttonClass="round" items={items}>
        <Icon name="dots" />
      </Menu>
    </>
  );
}

/** One campaign's page: its editor beside the preview, and its results once it is saved. */
export function CampaignEditor({
  api,
  me,
  members,
  workspace,
  campaignId,
  canEdit,
  onBack,
  onSaved,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  me: Me;
  members: Member[];
  workspace: TeamFace;
  /** Null for a new campaign. */
  campaignId: string | null;
  canEdit: boolean;
  onBack(): void;
  /** A new campaign was saved, so the address can name it. */
  onSaved(id: string): void;
  onOpenConversation(id: string): void;
}) {
  const loaded = useLoad(
    () => (campaignId === null ? null : api.campaign(campaignId)),
    [api, campaignId],
  );
  const appearance = useLoad(() => api.widget(), [api]);
  // A campaign saved here for the first time stays on screen while the address takes its ID.
  const [createdId, setCreatedId] = useState<string | null>(null);
  if (campaignId !== null && campaignId !== createdId && loaded.data === null) {
    return (
      <section className="page">
        <div className="page-body">
          <Loading failure={loaded.failure} />
        </div>
      </section>
    );
  }
  return (
    <CampaignPage
      api={api}
      me={me}
      members={members}
      workspace={workspace}
      initial={loaded.data?.campaign ?? null}
      appearance={appearance.data}
      canEdit={canEdit}
      onBack={onBack}
      onSaved={(id) => {
        setCreatedId(id);
        onSaved(id);
      }}
      onOpenConversation={onOpenConversation}
    />
  );
}

type Dialog =
  | { kind: "code" | "end" }
  | { kind: "test"; blockedBy: OutboundStatusReason | null; conversationId: string | null };

/**
 * What the page's buttons do, each while the page is busy, with its failure kept for the page. A
 * pause or an end keeps the changes not saved yet, and only a save clears them.
 */
function useCampaignActions({
  api,
  campaign,
  definition,
  unsaved,
  setCampaign,
  setEdited,
  setDialog,
  onSaved,
}: {
  api: WorkspaceApi;
  campaign: Campaign | null;
  definition: CampaignDefinition;
  unsaved: boolean;
  setCampaign(campaign: Campaign): void;
  setEdited(definition: CampaignDefinition | null): void;
  setDialog(dialog: Dialog | null): void;
  onSaved(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TextId | null>(null);
  const busyWhile = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(campaignFailure(error));
    } finally {
      setBusy(false);
    }
  };
  const run = (work: () => Promise<Campaign>, done: TextId, { saves }: { saves: boolean }) =>
    void busyWhile(async () => {
      setCampaign(await work());
      if (saves) setEdited(null);
      toast(done);
    });
  // Kept at once, so a resume that fails after a first save does not create it twice.
  const save = async () => {
    if (campaign !== null) return (await api.saveCampaign(definition)).campaign;
    const created = (await api.createCampaign(definition)).campaign;
    setCampaign(created);
    onSaved(created.id);
    return created;
  };
  const setStatus = (action: "pause" | "end", done: TextId) => {
    if (campaign === null) return;
    run(async () => (await api.setCampaignStatus(campaign.id, action)).campaign, done, {
      saves: false,
    });
  };
  const act = (action: Action) => {
    if (action === "end") return setDialog({ kind: "end" });
    if (action === "save") return run(save, "campaignSaved", { saves: true });
    if (action === "pause") return setStatus("pause", "campaignPausedToast");
    // Going live or resuming saves the changes first.
    run(
      async () => {
        const current = unsaved || campaign === null ? await save() : campaign;
        return (await api.setCampaignStatus(current.id, "resume")).campaign;
      },
      "campaignLiveToast",
      { saves: true },
    );
  };
  const end = () => {
    setDialog(null);
    setStatus("end", "campaignEndedToast");
  };
  const test = () =>
    void busyWhile(async () => {
      if (campaign === null) return;
      const sent = await api.testCampaign(campaign.id);
      setDialog({
        kind: "test",
        blockedBy: sent.blockedBy,
        conversationId: sent.outboundMessage.conversationId,
      });
    });
  return { busy, failure, act, end, test };
}

function CampaignPage({
  api,
  me,
  members,
  workspace,
  initial,
  appearance,
  canEdit,
  onBack,
  onSaved,
  onOpenConversation,
}: Omit<Parameters<typeof CampaignEditor>[0], "campaignId"> & {
  initial: Campaign | null;
  appearance: Awaited<ReturnType<WorkspaceApi["widget"]>> | null;
}) {
  const [campaign, setCampaign] = useState(initial);
  const [edited, setEdited] = useState<CampaignDefinition | null>(null);
  const [language, setLanguage] = useState<Language>("default");
  const [tab, setTab] = useState<"edit" | "results">("edit");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const formId = useId();
  const saved = campaign?.definition ?? null;
  const definition = edited ?? saved ?? newDefinition();
  const unsaved = edited !== null && JSON.stringify(edited) !== JSON.stringify(saved);
  const editable = canEdit && campaign?.status !== "ended";
  const { busy, failure, act, end, test } = useCampaignActions({
    api,
    campaign,
    definition,
    unsaved,
    setCampaign,
    setEdited,
    setDialog,
    onSaved,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    act(submitter instanceof HTMLButtonElement ? (submitter.value as Action) : "save");
  };
  const title = definition.name.trim() === "" ? t("campaignNew") : definition.name;
  return (
    <section className="page campaign-page" aria-label={title}>
      <LeaveGuard unsaved={unsaved} />
      <button type="button" className="text-button back-link" onClick={onBack}>
        <Icon name="back" size={14} />
        {t("campaigns")}
      </button>
      <PageHead
        title={title}
        context={
          <>
            <StatusChip status={campaign?.status ?? "draft"} />{" "}
            {definition.key !== "" && <span className="mono">{definition.key}</span>}
          </>
        }
        actions={
          <EditorActions
            campaign={campaign}
            canEdit={canEdit}
            unsaved={unsaved}
            busy={busy}
            formId={formId}
            onAction={act}
            onTest={test}
            onCode={() => setDialog({ kind: "code" })}
          />
        }
      />
      <div className="page-body">
        <ErrorNote text={failure} />
        {campaign !== null && (
          <Choices<"edit" | "results">
            label={t("campaignTabs")}
            variant="tabs"
            value={tab}
            options={[
              { value: "edit", label: "campaignTabEdit" },
              { value: "results", label: "campaignTabResults" },
            ]}
            onChange={setTab}
          />
        )}
        {tab === "results" && campaign !== null ? (
          <CampaignResultsView api={api} campaign={campaign} />
        ) : (
          <div className="appearance campaign-editor">
            {appearance !== null && (
              <CampaignPreview
                definition={definition}
                appearance={appearance}
                me={me}
                members={members}
                workspace={workspace}
                language={language}
                onLanguage={setLanguage}
              />
            )}
            <CampaignForm
              api={api}
              formId={formId}
              editable={editable}
              isNew={campaign === null}
              definition={definition}
              members={members}
              language={language}
              onLanguage={setLanguage}
              onChange={setEdited}
              onSubmit={submit}
            >
              {!canEdit && <p className="note">{t("campaignMemberNote")}</p>}
              {campaign?.status === "live" && canEdit && (
                <p className="note">{t("campaignLiveNote")}</p>
              )}
            </CampaignForm>
          </div>
        )}
      </div>
      {dialog?.kind === "code" && (
        <CodeDialog definition={definition} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "test" && (
        <TestDialog
          blockedBy={dialog.blockedBy}
          conversationId={dialog.conversationId}
          onOpenConversation={onOpenConversation}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "end" && (
        <Confirm
          title={t("campaignEndTitle", { name: title })}
          text={t("campaignEndText")}
          confirm={t("campaignEnd")}
          onConfirm={end}
          onCancel={() => setDialog(null)}
        />
      )}
    </section>
  );
}
