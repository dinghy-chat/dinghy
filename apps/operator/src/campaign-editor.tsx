/** @jsxImportSource react */
import { type FormEvent, type ReactNode, useId, useState } from "react";
import {
  CAMPAIGN_KEY_PATTERN,
  CAMPAIGN_NAME_MAX,
  type TeamFace,
} from "../../../packages/widget/src/shared.ts";
import {
  ApiError,
  type Campaign,
  type CampaignDefinition,
  type Me,
  type Member,
  type OutboundStatusReason,
  type WorkspaceApi,
} from "./api.ts";
import { LeaveGuard } from "./appearance.tsx";
import { CodeDialog, TestDialog } from "./campaign-dialogs.tsx";
import { keyFromName, newDefinition } from "./campaign-draft.ts";
import { CampaignSteps } from "./campaign-form.tsx";
import type { Language } from "./campaign-message.tsx";
import { CampaignPreview } from "./campaign-preview.tsx";
import { CampaignResultsView } from "./campaign-results.tsx";
import { StatusChip } from "./campaign-tile.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { Confirm, Menu, type MenuItem } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Choices, ErrorNote, failureText, Loading } from "./ui.tsx";
import { ago } from "./visitor.ts";

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

type Action = "save" | "live" | "pause" | "resume" | "end";

/**
 * The page's buttons: a test, a save, the code and the end in a menu, and the one step the status
 * allows next, go live, pause or resume.
 */
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
  // Save is the form's first submit button, so Enter in a field saves. With nothing to save it is
  // disabled, which stops Enter there, so Enter never reaches Go live or Resume.
  const submit = (
    action: Action,
    label: TextId,
    { isDark = false, isIdle = false }: { isDark?: boolean; isIdle?: boolean } = {},
  ): ReactNode => (
    <button
      type="submit"
      form={formId}
      value={action}
      className={isDark ? "pill dark" : "pill"}
      disabled={busy || isIdle}
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
          {t("campaignTest")}
        </button>
      )}
      {editable &&
        submit("save", status === "draft" ? "campaignSaveDraft" : "save", {
          isIdle: !unsaved && campaign !== null,
        })}
      <Menu label={t("moreActions")} buttonClass="round" items={items}>
        <Icon name="dots" />
      </Menu>
      {editable && status === "draft" && submit("live", "campaignGoLive", { isDark: true })}
      {editable && status === "paused" && submit("resume", "campaignResume", { isDark: true })}
      {editable && status === "live" && (
        <button
          type="button"
          className="pill dark"
          disabled={busy}
          onClick={() => onAction("pause")}
        >
          <Icon name="pause" size={18} />
          {t("campaignPause")}
        </button>
      )}
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

/** "Saved 2 minutes ago", or that the changes wait for a save. */
function savedText(campaign: Campaign | null, unsaved: boolean): string {
  if (campaign === null) return t("campaignNotSaved");
  if (unsaved) return t("campaignUnsaved");
  return t("campaignSavedAgo", { ago: ago(campaign.updatedAt) });
}

/**
 * The campaign's name as the page's title, its status, when it was saved and its key. A new
 * campaign's key follows its name until someone types one, and a saved one's never changes.
 */
function CampaignHead({
  definition,
  campaign,
  editable,
  unsaved,
  actions,
  onChange,
}: {
  definition: CampaignDefinition;
  campaign: Campaign | null;
  editable: boolean;
  unsaved: boolean;
  actions: ReactNode;
  onChange(definition: CampaignDefinition): void;
}) {
  const [isKeyTyped, setKeyTyped] = useState(false);
  return (
    <header className="page-head campaign-head">
      <div className="page-title">
        <div className="campaign-title">
          <input
            className="title-input"
            aria-label={t("campaignName")}
            placeholder={t("campaignNew")}
            required
            maxLength={CAMPAIGN_NAME_MAX}
            disabled={!editable}
            value={definition.name}
            onChange={(event) => {
              const name = event.target.value;
              const followsName = campaign === null && !isKeyTyped;
              onChange({ ...definition, name, ...(followsName && { key: keyFromName(name) }) });
            }}
          />
          <StatusChip status={campaign?.status ?? "draft"} />
        </div>
        <p>
          {savedText(campaign, unsaved)} · {t("campaignKeyWord")}{" "}
          {campaign === null ? (
            <input
              className="key-input mono"
              aria-label={t("campaignKey")}
              title={t("campaignKeyHelp")}
              required
              disabled={!editable}
              pattern={CAMPAIGN_KEY_PATTERN}
              value={definition.key}
              onChange={(event) => {
                setKeyTyped(true);
                onChange({ ...definition, key: event.target.value });
              }}
            />
          ) : (
            <code title={t("campaignKeyFixed")}>{definition.key}</code>
          )}
        </p>
      </div>
      <div className="page-actions">{actions}</div>
    </header>
  );
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
  // One object for a new campaign, so the preview's memo holds until the first change.
  const [blank] = useState(newDefinition);
  const formId = useId();
  const saved = campaign?.definition ?? null;
  const definition = edited ?? saved ?? blank;
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
      <form id={formId} className="campaign-form" onSubmit={submit}>
        <button type="button" className="text-button back-link" onClick={onBack}>
          <Icon name="back" size={14} />
          {t("campaigns")}
        </button>
        <CampaignHead
          definition={definition}
          campaign={campaign}
          editable={editable}
          unsaved={unsaved}
          onChange={setEdited}
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
              variant="pills"
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
              <div className="widget-form">
                {!canEdit && <p className="note">{t("campaignMemberNote")}</p>}
                {campaign?.status === "live" && canEdit && (
                  <p className="note">{t("campaignLiveNote")}</p>
                )}
                <CampaignSteps
                  api={api}
                  definition={definition}
                  members={members}
                  language={language}
                  editable={editable}
                  onLanguage={setLanguage}
                  onChange={setEdited}
                />
              </div>
            </div>
          )}
        </div>
      </form>
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
