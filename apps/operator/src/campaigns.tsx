/** @jsxImportSource react */
// The Campaigns page: the list with each campaign's sentence, status and results, the templates
// to start from, and one campaign's editor and results.
import { useState } from "react";
import { CAMPAIGN_GAP_HOURS_MAX, type TeamFace } from "../../../packages/widget/src/shared.ts";
import type {
  Campaign,
  CampaignSettingsView,
  CampaignStatus,
  Me,
  Member,
  Role,
  WorkspaceApi,
} from "./api.ts";
import { PausedBanner, type PausedTexts } from "./bots.tsx";
import { EndingConfirm, RenameDialog } from "./campaign-dialogs.tsx";
import { CampaignEditor, campaignFailure } from "./campaign-editor.tsx";
import { CampaignRow, type RowAction } from "./campaign-row.tsx";
import { freeKey, TEMPLATES } from "./campaign-templates.ts";
import { Tile } from "./campaign-tile.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { Menu, type MenuItem } from "./popup.tsx";
import { TableSkeleton } from "./skeleton.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import {
  Choices,
  ErrorNote,
  Field,
  FormDialog,
  failureText,
  Loading,
  type Option,
  Page,
} from "./ui.tsx";

/** The address's word for a campaign not saved yet. */
const NEW_CAMPAIGN = "new";

type Filter = "all" | CampaignStatus;
/** The status tabs, in order, each named for its campaigns. */
const STATUS_TABS: { value: CampaignStatus; label: TextId }[] = [
  { value: "live", label: "campaignLive" },
  { value: "draft", label: "campaignsDrafts" },
  { value: "paused", label: "campaignPaused" },
  { value: "ended", label: "campaignEnded" },
];

const CAMPAIGNS_PAUSED: PausedTexts = {
  banner: "campaignsPausedBanner",
  more: "campaignsPausedMore",
  short: "campaignsPausedShort",
  resume: "campaignsResumeAll",
};

/** "Hours between campaign messages", for every campaign together. A member reads it. */
function GapDialog({
  gapHours,
  canEdit,
  onSave,
  onClose,
}: {
  gapHours: number;
  canEdit: boolean;
  onSave(gapHours: number): Promise<TextId | null>;
  onClose(): void;
}) {
  const [typed, setTyped] = useState(String(gapHours));
  const [failure, setFailure] = useState<TextId | null>(null);
  return (
    <FormDialog
      title={t("campaignGap")}
      help={t("campaignGapHelp")}
      failure={failure}
      submitLabel={t("save")}
      submitDisabled={!canEdit}
      onSubmit={(close) =>
        void onSave(Number(typed)).then((refused) =>
          refused === null ? close() : setFailure(refused),
        )
      }
      onClose={onClose}
    >
      <Field
        label={t("campaignGapField")}
        type="number"
        min={0}
        max={CAMPAIGN_GAP_HOURS_MAX}
        required
        disabled={!canEdit}
        value={typed}
        onChange={setTyped}
      />
    </FormDialog>
  );
}

/** The four campaigns to start from. Each saves a draft with a free key, and opens it. */
function Templates({
  api,
  taken,
  onOpen,
}: {
  api: WorkspaceApi;
  taken: ReadonlySet<string>;
  onOpen(id: string): void;
}) {
  const [isBusy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TextId | null>(null);
  const start = async (template: (typeof TEMPLATES)[number]) => {
    setBusy(true);
    setFailure(null);
    try {
      const definition = template.definition();
      const { campaign } = await api.createCampaign({
        ...definition,
        key: freeKey(definition.key, taken),
      });
      onOpen(campaign.id);
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
      setBusy(false);
    }
  };
  return (
    <section className="campaign-templates" aria-labelledby="campaign-templates">
      <h3 id="campaign-templates">{t("templatesTitle")}</h3>
      <p className="hint">{t("templatesHelp")}</p>
      <ErrorNote text={failure} />
      <div className="template-cards">
        {TEMPLATES.map((template) => (
          <button
            key={template.title}
            type="button"
            className="template-card"
            disabled={isBusy}
            onClick={() => void start(template)}
          >
            <Tile icon={template.icon} tint={template.tint} />
            <b>{t(template.title)}</b>
            <small>{t(template.text)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The header's buttons: the rules for every campaign in a menu, and New campaign. Pause all shows
 * while a campaign is live, and Resume all while they are paused.
 */
function ListActions({
  settings,
  isAnyLive,
  canEdit,
  onPause,
  onGap,
  onNew,
}: {
  settings: CampaignSettingsView | null;
  isAnyLive: boolean;
  canEdit: boolean;
  onPause(paused: boolean): void;
  onGap(): void;
  onNew(): void;
}) {
  if (settings === null) return null;
  const items: MenuItem[] = [];
  if (canEdit && (settings.paused || isAnyLive)) {
    items.push({
      label: t(settings.paused ? "campaignsResumeAll" : "campaignsPauseAll"),
      lead: <Icon name={settings.paused ? "play" : "pause"} size={18} />,
      onSelect: () => onPause(!settings.paused),
    });
  }
  items.push({ label: t("campaignGap"), lead: <Icon name="clock" size={18} />, onSelect: onGap });
  return (
    <>
      <Menu label={t("moreActions")} buttonClass="round" items={items}>
        <Icon name="dots" />
      </Menu>
      {canEdit && (
        <button type="button" className="pill dark" onClick={onNew}>
          <Icon name="plusBold" size={14} />
          {t("campaignNew")}
        </button>
      )}
    </>
  );
}

/** "1 live · 214 sent in the last 7 days", or what campaigns are before there is one. */
function listContext(campaigns: Campaign[] | null, sentLastWeek: number): string {
  if (campaigns === null || campaigns.length === 0) return t("campaignsContext");
  const live = campaigns.filter((one) => one.status === "live").length;
  return t("campaignsSummary", { live, sent: sentLastWeek.toLocaleString() });
}

/** The campaigns by status, one row each. */
function CampaignRows({
  campaigns,
  onOpen,
  onAction,
}: {
  campaigns: Campaign[];
  onOpen(id: string): void;
  /** Null for a member, who reads campaigns only. */
  onAction: ((campaign: Campaign, action: RowAction) => void) | null;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  // A tab with no campaign shows no count.
  const countOf = (count: number) => (count === 0 ? undefined : count);
  const filters: Option<Filter>[] = [
    { value: "all", label: "campaignsAll", count: countOf(campaigns.length) },
    ...STATUS_TABS.map((tab) => ({
      ...tab,
      count: countOf(campaigns.filter((one) => one.status === tab.value).length),
    })),
  ];
  const shown = campaigns.filter((one) => filter === "all" || one.status === filter);
  return (
    <>
      <Choices<Filter>
        label={t("campaignsFilter")}
        variant="pills"
        value={filter}
        options={filters}
        onChange={setFilter}
      />
      {shown.length === 0 ? (
        <p className="quiet">{t("campaignsNoneHere")}</p>
      ) : (
        <ul className="campaign-rows">
          {shown.map((campaign) => (
            <CampaignRow
              key={campaign.id}
              campaign={campaign}
              onOpen={() => onOpen(campaign.id)}
              onAction={onAction && ((action) => onAction(campaign, action))}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** A row's action that waits for a dialog. */
type Asked =
  | { campaign: Campaign; action: "rename" }
  | { campaign: Campaign; action: "end" | "delete" };

/** Every campaign, by status, with Pause all, the gap between two messages, and the templates. */
function CampaignList({
  api,
  canEdit,
  version,
  onOpen,
}: {
  api: WorkspaceApi;
  canEdit: boolean;
  version: number;
  onOpen(id: string): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  const list = useLoad(() => api.campaigns(), [api, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a load.
  const loadedSettings = useLoad(() => api.campaignSettings(), [api, version]);
  const [failure, setFailure] = useState<TextId | null>(null);
  const [isGapOpen, setGapOpen] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const settings = loadedSettings.data;
  const campaigns = list.data?.campaigns ?? null;
  /** Saves a change of the settings, and answers why it failed, or null. */
  const saveSettings = async (change: Partial<CampaignSettingsView>, done: TextId) => {
    if (settings === null) return null;
    try {
      loadedSettings.setData(await api.setCampaignSettings({ ...settings, ...change }));
      toast(done);
      return null;
    } catch (error) {
      return failureText(error, {}, "actionFailed");
    }
  };
  /** Runs a row's action, then reads the list again. Answers why it failed, or null. */
  const run = async (work: () => Promise<unknown>, done: TextId) => {
    try {
      await work();
      toast(done);
      list.reload();
      return null;
    } catch (error) {
      return campaignFailure(error);
    }
  };
  const confirmed = ({ campaign, action }: Extract<Asked, { action: "end" | "delete" }>) => {
    setAsked(null);
    void run(
      () =>
        action === "end"
          ? api.setCampaignStatus(campaign.id, "end")
          : api.deleteCampaign(campaign.id),
      action === "end" ? "campaignEndedToast" : "campaignDeleted",
    ).then(setFailure);
  };
  const pause = async (paused: boolean) =>
    setFailure(
      await saveSettings({ paused }, paused ? "campaignsPausedToast" : "campaignsResumedToast"),
    );
  return (
    <Page
      title={t("campaigns")}
      context={listContext(campaigns, list.data?.sentLastWeek ?? 0)}
      actions={
        <ListActions
          settings={settings}
          isAnyLive={campaigns?.some((one) => one.status === "live") ?? false}
          canEdit={canEdit}
          onPause={(paused) => void pause(paused)}
          onGap={() => setGapOpen(true)}
          onNew={() => onOpen(NEW_CAMPAIGN)}
        />
      }
    >
      <div className="campaign-list">
        {settings?.paused === true && (
          <PausedBanner
            texts={CAMPAIGNS_PAUSED}
            pausedBy={settings.pausedBy}
            pausedAt={settings.pausedAt}
            onResume={canEdit ? () => void pause(false) : null}
          />
        )}
        <ErrorNote text={failure} />
        {campaigns === null ? (
          <Loading failure={list.failure}>
            <TableSkeleton />
          </Loading>
        ) : campaigns.length === 0 ? (
          <p className="campaign-empty">
            <b>{t("campaignsEmpty")}</b> {t("campaignsEmptyHint")}
          </p>
        ) : (
          <CampaignRows
            campaigns={campaigns}
            onOpen={onOpen}
            onAction={canEdit ? (campaign, action) => setAsked({ campaign, action }) : null}
          />
        )}
        {campaigns !== null && canEdit && (
          <Templates
            api={api}
            taken={new Set(campaigns.map((one) => one.definition.key))}
            onOpen={onOpen}
          />
        )}
      </div>
      {isGapOpen && settings !== null && (
        <GapDialog
          gapHours={settings.gapHours}
          canEdit={canEdit}
          onSave={(gapHours) => saveSettings({ gapHours }, "saved")}
          onClose={() => setGapOpen(false)}
        />
      )}
      {asked?.action === "rename" && (
        <RenameDialog
          name={asked.campaign.definition.name}
          onSave={(name) =>
            run(() => api.renameCampaign(asked.campaign.id, name), "campaignRenamed")
          }
          onClose={() => setAsked(null)}
        />
      )}
      {asked !== null && asked.action !== "rename" && (
        <EndingConfirm
          kind={asked.action}
          name={asked.campaign.definition.name}
          onConfirm={() => confirmed(asked)}
          onCancel={() => setAsked(null)}
        />
      )}
    </Page>
  );
}

/** The Campaigns view: the list, or one campaign. Members read them, and only owners and admins change them. */
export function CampaignsPage({
  api,
  me,
  role,
  members,
  workspace,
  campaignId,
  version,
  onCampaign,
  onOpenConversation,
}: {
  api: WorkspaceApi;
  me: Me;
  role: Role;
  members: Member[];
  workspace: TeamFace;
  /** The campaign on screen, `new` for one not saved yet, or null for the list. */
  campaignId: string | null;
  /** Goes up on every change in the workspace. */
  version: number;
  onCampaign(id: string | null): void;
  onOpenConversation(id: string): void;
}) {
  const canEdit = role !== "member";
  if (campaignId === null) {
    return <CampaignList api={api} canEdit={canEdit} version={version} onOpen={onCampaign} />;
  }
  return (
    <CampaignEditor
      api={api}
      me={me}
      members={members}
      workspace={workspace}
      campaignId={campaignId === NEW_CAMPAIGN ? null : campaignId}
      canEdit={canEdit}
      onBack={() => onCampaign(null)}
      onSaved={onCampaign}
      onOpenConversation={onOpenConversation}
    />
  );
}
