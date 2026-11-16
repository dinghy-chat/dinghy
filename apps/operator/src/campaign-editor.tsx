/** @jsxImportSource react */
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  CAMPAIGN_KEY_PATTERN,
  CAMPAIGN_NAME_MAX,
  type TeamFace,
} from "../../../packages/widget/src/shared.ts";
import type {
  Campaign,
  CampaignDefinition,
  Me,
  Member,
  OutboundStatusReason,
  WorkspaceApi,
} from "./api.ts";
import { LeaveGuard } from "./appearance.tsx";
import {
  campaignFailure,
  type Ending,
  EndingConfirm,
  endedText,
  endingItem,
  stopCampaign,
} from "./campaign-actions.tsx";
import { CodeDialog, GoLiveDialog, TestDialog } from "./campaign-dialogs.tsx";
import { copyOf, keyFromName, newDefinition } from "./campaign-draft.ts";
import { CampaignSteps } from "./campaign-form.tsx";
import type { Language } from "./campaign-message.tsx";
import { CampaignOverview } from "./campaign-overview.tsx";
import { CampaignPreview } from "./campaign-preview.tsx";
import { CampaignResultsView } from "./campaign-results.tsx";
import { freeKey } from "./campaign-templates.ts";
import { StatusChip } from "./campaign-tile.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { Menu, type MenuItem } from "./popup.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Choices, ErrorNote, Loading } from "./ui.tsx";
import { ago } from "./visitor.ts";

type Action = "save" | "live" | "pause" | "resume" | "duplicate" | Ending;

/**
 * The page's buttons: a save, the one step the status allows next, go live, pause or resume, and
 * the rest in a menu: a test, a duplicate, the code, the end and the delete. An ended campaign's
 * one step is its duplicate.
 */
function EditorActions({
  campaign,
  canEdit,
  unsaved,
  busy,
  formId,
  onAction,
  onGoLive,
  onTest,
  onCode,
}: {
  campaign: Campaign | null;
  canEdit: boolean;
  unsaved: boolean;
  busy: boolean;
  formId: string;
  onAction(action: Action): void;
  onGoLive(): void;
  onTest(): void;
  onCode(): void;
}) {
  const status = campaign?.status ?? "draft";
  // Save is the form's first submit button, so Enter in a field saves. With nothing to save it is
  // disabled, which stops Enter there, so Enter never reaches Resume. A saved draft saves itself,
  // so it has no Save, and Go live is no submit.
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
  const canDuplicate = canEdit && campaign !== null;
  const items: MenuItem[] = [];
  if (campaign !== null && status !== "ended") {
    items.push({
      label: t("campaignTest"),
      lead: <Icon name="flask" size={18} />,
      ...(unsaved && { unavailable: t("campaignTestSaveFirst") }),
      onSelect: onTest,
    });
  }
  if (canDuplicate && status !== "ended") {
    items.push({
      label: t("campaignDuplicate"),
      lead: <Icon name="copy" size={18} />,
      ...(unsaved && { unavailable: t("campaignDuplicateSaveFirst") }),
      onSelect: () => onAction("duplicate"),
    });
  }
  items.push({ label: t("campaignCode"), lead: <Icon name="code" size={18} />, onSelect: onCode });
  const ending = canEdit && campaign !== null ? endingItem(campaign, onAction) : null;
  if (ending !== null) items.push({ ...ending, divider: true });
  return (
    <>
      {editable &&
        (campaign === null || status !== "draft") &&
        submit("save", campaign === null ? "campaignSaveDraft" : "save", { isIdle: !unsaved })}
      {editable && status === "draft" && (
        // Not a submit, so Enter in a field never starts it: it asks first.
        <button type="button" className="pill dark" disabled={busy} onClick={onGoLive}>
          {t("campaignGoLive")}
        </button>
      )}
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
      {canDuplicate && status === "ended" && (
        <button
          type="button"
          className="pill dark"
          disabled={busy}
          onClick={() => onAction("duplicate")}
        >
          {t("campaignDuplicate")}
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
  onOpen,
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
  /** Opens another campaign, such as a duplicate. */
  onOpen(id: string): void;
  onOpenConversation(id: string): void;
}) {
  const loaded = useLoad(
    () => (campaignId === null ? null : api.campaign(campaignId)),
    [api, campaignId],
  );
  const appearance = useLoad(() => api.widget(), [api]);
  // A campaign saved here for the first time stays on screen while the address takes its ID.
  const [createdId, setCreatedId] = useState<string | null>(null);
  // The load keeps the last campaign while the next one loads, as after a duplicate opens.
  const current = loaded.data?.campaign.id === campaignId ? loaded.data.campaign : null;
  if (campaignId !== null && campaignId !== createdId && current === null) {
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
      // A new page for each campaign, but not for a new one as it takes its ID.
      key={campaignId === createdId ? "new" : (campaignId ?? "new")}
      api={api}
      me={me}
      members={members}
      workspace={workspace}
      initial={current}
      appearance={appearance.data}
      canEdit={canEdit}
      onBack={onBack}
      onSaved={(id) => {
        setCreatedId(id);
        onSaved(id);
      }}
      onOpen={onOpen}
      onOpenConversation={onOpenConversation}
    />
  );
}

type Dialog =
  | { kind: "code" | "live" | Ending }
  | { kind: "test"; blockedBy: OutboundStatusReason | null; conversationId: string | null };

/**
 * What the page's buttons do, each while the page is busy, with its failure kept for the page. A
 * pause or an end keeps the changes not saved yet, and only a save clears them.
 */
function useCampaignActions({
  api,
  campaign,
  definition,
  members,
  unsaved,
  setCampaign,
  setEdited,
  setDialog,
  onSaved,
  onOpen,
  onDeleted,
}: {
  api: WorkspaceApi;
  campaign: Campaign | null;
  definition: CampaignDefinition;
  members: Member[];
  unsaved: boolean;
  setCampaign(campaign: Campaign): void;
  setEdited(definition: CampaignDefinition | null): void;
  setDialog(dialog: Dialog | null): void;
  onSaved(id: string): void;
  onOpen(id: string): void;
  onDeleted(): void;
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
  /** Saves a copy of the saved campaign as a new draft with a free key, and opens it. */
  const duplicate = () =>
    void busyWhile(async () => {
      if (campaign === null) return;
      const saved = campaign.definition;
      const { campaigns } = await api.campaigns();
      const copy = copyOf(saved, {
        name: t("campaignCopyName", { name: saved.name }).slice(0, CAMPAIGN_NAME_MAX),
        key: freeKey(saved.key, new Set(campaigns.map((one) => one.definition.key))),
        members,
        now: new Date(),
      });
      onOpen((await api.createCampaign(copy)).campaign.id);
    });
  const act = (action: Action) => {
    if (action === "end" || action === "delete") return setDialog({ kind: action });
    if (action === "duplicate") return duplicate();
    if (action === "save") return run(save, "campaignSaved", { saves: true });
    if (action === "pause") {
      if (campaign === null) return;
      return run(
        async () => (await api.setCampaignStatus(campaign.id, "pause")).campaign,
        "campaignPausedToast",
        { saves: false },
      );
    }
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
  /** Ends or deletes it, once the operator confirmed. A delete leaves the page. */
  const finish = (kind: Ending) => {
    setDialog(null);
    if (campaign === null) return;
    void busyWhile(async () => {
      const after = await stopCampaign(api, campaign, kind);
      toast(endedText(kind));
      if (after !== null) return setCampaign(after);
      // Its changes not saved go with it, so leaving the page asks nothing.
      flushSync(() => setEdited(null));
      onDeleted();
    });
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
  return { busy, failure, act, finish, test };
}

/** How long a draft waits after the last change before it saves itself. */
const AUTOSAVE_DELAY_MS = 800;

/**
 * Saves a saved draft a moment after each change, while the form is valid. A live or paused
 * campaign waits for Save, since a save changes what it sends. Answers why the last try failed.
 */
function useDraftAutosave({
  api,
  campaign,
  edited,
  unsaved,
  form,
  setCampaign,
  setEdited,
}: {
  api: WorkspaceApi;
  campaign: Campaign | null;
  edited: CampaignDefinition | null;
  unsaved: boolean;
  form: RefObject<HTMLFormElement | null>;
  setCampaign(campaign: Campaign): void;
  setEdited: Dispatch<SetStateAction<CampaignDefinition | null>>;
}): TextId | null {
  const [failure, setFailure] = useState<TextId | null>(null);
  // It runs again on each new campaign from the server, so a change typed while a save ran saves
  // in its turn.
  useEffect(() => {
    if (campaign?.status !== "draft" || edited === null || !unsaved) return;
    const timer = setTimeout(() => {
      if (form.current?.checkValidity() !== true) return;
      api.saveCampaign(edited).then(
        (saved) => {
          setFailure(null);
          setCampaign(saved.campaign);
          setEdited((current) => (current === edited ? null : current));
        },
        (error: unknown) => setFailure(campaignFailure(error)),
      );
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [api, campaign, edited, unsaved, form, setCampaign, setEdited]);
  return failure;
}

/** "Saved 2 minutes ago", "Ended 3 days ago", or that the changes wait for a save. */
function savedText(campaign: Campaign | null, unsaved: boolean): string {
  if (campaign === null) return t("campaignNotSaved");
  if (campaign.endedAt !== null) return t("campaignEndedAgo", { ago: ago(campaign.endedAt) });
  if (unsaved) return t("campaignUnsaved");
  return t("campaignSavedAgo", { ago: ago(campaign.updatedAt) });
}

/**
 * The campaign's name as the page's title, its status, when it was saved and its key. The name
 * changes in place while the campaign can change. A new campaign's key follows its name until
 * someone types one, and a saved one's never changes.
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
          {editable ? (
            <label className="title-edit">
              <input
                className="title-input"
                aria-label={t("campaignName")}
                title={t("campaignRenameHint")}
                placeholder={t("campaignNew")}
                required
                maxLength={CAMPAIGN_NAME_MAX}
                value={definition.name}
                onChange={(event) => {
                  const name = event.target.value;
                  const followsName = campaign === null && !isKeyTyped;
                  onChange({ ...definition, name, ...(followsName && { key: keyFromName(name) }) });
                }}
              />
              <Icon name="pencil" size={18} />
            </label>
          ) : (
            <h2>{definition.name}</h2>
          )}
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
  onOpen,
  onOpenConversation,
}: Omit<Parameters<typeof CampaignEditor>[0], "campaignId"> & {
  initial: Campaign | null;
  appearance: Awaited<ReturnType<WorkspaceApi["widget"]>> | null;
}) {
  const [campaign, setCampaign] = useState(initial);
  const [edited, setEdited] = useState<CampaignDefinition | null>(null);
  const [language, setLanguage] = useState<Language>("default");
  // An ended campaign changes no more, so its results come first.
  const [tab, setTab] = useState<"edit" | "results">(
    initial?.status === "ended" ? "results" : "edit",
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // One object for a new campaign, so the preview's memo holds until the first change.
  const [blank] = useState(newDefinition);
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const saved = campaign?.definition ?? null;
  const definition = edited ?? saved ?? blank;
  const unsaved = edited !== null && JSON.stringify(edited) !== JSON.stringify(saved);
  const editable = canEdit && campaign?.status !== "ended";
  const { busy, failure, act, finish, test } = useCampaignActions({
    api,
    campaign,
    definition,
    members,
    unsaved,
    setCampaign,
    setEdited,
    setDialog,
    onSaved,
    onOpen,
    onDeleted: onBack,
  });
  const autosaveFailure = useDraftAutosave({
    api,
    campaign,
    edited,
    unsaved,
    form,
    setCampaign,
    setEdited,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    act(submitter instanceof HTMLButtonElement ? (submitter.value as Action) : "save");
  };
  const title = definition.name.trim() === "" ? t("campaignNew") : definition.name;
  const ending = dialog?.kind === "end" || dialog?.kind === "delete" ? dialog.kind : null;
  return (
    <section className="page campaign-page" aria-label={title}>
      <LeaveGuard unsaved={unsaved} />
      <form ref={form} id={formId} className="campaign-form" onSubmit={submit}>
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
              onGoLive={() => {
                if (form.current?.reportValidity()) setDialog({ kind: "live" });
              }}
              onTest={test}
              onCode={() => setDialog({ kind: "code" })}
            />
          }
        />
        <div className="page-body">
          <ErrorNote text={failure ?? autosaveFailure} />
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
                {campaign?.status === "ended" ? (
                  <p className="note">
                    {t(canEdit ? "campaignEndedNoteCopy" : "campaignEndedNote")}
                  </p>
                ) : (
                  !canEdit && <p className="note">{t("campaignMemberNote")}</p>
                )}
                {campaign?.status === "live" && canEdit && (
                  <p className="note">{t("campaignLiveNote")}</p>
                )}
                {editable ? (
                  <CampaignSteps
                    api={api}
                    definition={definition}
                    members={members}
                    language={language}
                    onLanguage={setLanguage}
                    onChange={setEdited}
                  />
                ) : (
                  <CampaignOverview definition={definition} members={members} language={language} />
                )}
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
      {ending !== null && (
        <EndingConfirm
          kind={ending}
          name={title}
          onConfirm={() => finish(ending)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "live" && (
        <GoLiveDialog
          definition={definition}
          onConfirm={() => {
            setDialog(null);
            act("live");
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
