/** @jsxImportSource react */
// The Campaigns page: the list with each campaign's status, trigger and results, the rules for every
// campaign, and one campaign's editor and results.
import { type FormEvent, useState } from "react";
import type { TeamFace } from "../../../packages/widget/src/shared.ts";
import type {
  Campaign,
  CampaignSettings,
  CampaignStatus,
  Me,
  Member,
  Role,
  WorkspaceApi,
} from "./api.ts";
import { PausedBanner, type PausedTexts } from "./bots.tsx";
import { CampaignEditor, STATUS_TEXT, StatusChip } from "./campaign-editor.tsx";
import { triggerWords } from "./campaign-trigger.tsx";
import { Icon } from "./icons.tsx";
import { useLoad } from "./load.ts";
import { EmptyArt } from "./scene.tsx";
import { TableSkeleton } from "./skeleton.tsx";
import { type TextId, t } from "./text.ts";
import { toast } from "./toast.tsx";
import { Choices, ErrorNote, failureText, Loading, type Option, Page, SettingRow } from "./ui.tsx";

/** The address's word for a campaign not saved yet. */
const NEW_CAMPAIGN = "new";

type Filter = "all" | CampaignStatus;
const STATUSES: CampaignStatus[] = ["draft", "live", "paused", "ended"];

const CAMPAIGNS_PAUSED: PausedTexts = {
  banner: "campaignsPausedBanner",
  more: "campaignsPausedMore",
  short: "campaignsPausedShort",
  resume: "campaignsResumeAll",
};

const GAP_HOURS_MAX = 720;

function CampaignRow({ campaign, onOpen }: { campaign: Campaign; onOpen(): void }) {
  const { definition, totals } = campaign;
  return (
    <tr>
      <td>
        <button type="button" className="who-cell contact-open" onClick={onOpen}>
          <span className="who-lines">
            <b>{definition.name}</b>
            <span className="mono">{definition.key}</span>
          </span>
        </button>
      </td>
      <td>
        <StatusChip status={campaign.status} />
      </td>
      <td className="wide-cell">{triggerWords(definition.trigger)}</td>
      <td className="number-cell">{totals.sent}</td>
      <td className="number-cell">{totals.read}</td>
      <td className="number-cell">{totals.replied}</td>
      <td className="number-cell wide-cell">{totals.goalReached}</td>
    </tr>
  );
}

/** The rules for every campaign: the pause, and the fewest hours between two messages to one visitor. */
function AllCampaignsRules({
  settings,
  canEdit,
  onSave,
}: {
  settings: CampaignSettings;
  canEdit: boolean;
  onSave(change: Partial<CampaignSettings>, done: TextId): Promise<void>;
}) {
  const [typed, setTyped] = useState(String(settings.gapHours));
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await onSave({ gapHours: Number(typed) }, "saved");
    setBusy(false);
  };
  return (
    <section className="widget-section" aria-label={t("campaignsRules")}>
      <h3>{t("campaignsRules")}</h3>
      <form className="setting-rows" onSubmit={(event) => void save(event)}>
        {canEdit && (
          <SettingRow label={t("campaignsPauseAll")} hint={t("campaignsPauseAllHelp")}>
            {() => (
              <button
                type="button"
                className="pill"
                onClick={() =>
                  void onSave(
                    { paused: !settings.paused },
                    settings.paused ? "campaignsResumedToast" : "campaignsPausedToast",
                  )
                }
              >
                <Icon name={settings.paused ? "play" : "pause"} size={18} />
                {t(settings.paused ? "campaignsResumeAll" : "campaignsPauseAll")}
              </button>
            )}
          </SettingRow>
        )}
        <SettingRow label={t("campaignGap")} hint={t("campaignGapHelp")}>
          {(hintId) => (
            <div className="inline-field">
              <input
                aria-label={t("campaignGap")}
                aria-describedby={hintId}
                type="number"
                min={0}
                max={GAP_HOURS_MAX}
                required
                disabled={!canEdit}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
              {canEdit && (
                <button
                  type="submit"
                  className="pill dark"
                  disabled={busy || typed === String(settings.gapHours)}
                >
                  {t("save")}
                </button>
              )}
            </div>
          )}
        </SettingRow>
      </form>
    </section>
  );
}

function CampaignTable({ campaigns, onOpen }: { campaigns: Campaign[]; onOpen(id: string): void }) {
  return (
    <table className="members contacts">
      <thead>
        <tr>
          <th scope="col">{t("colName")}</th>
          <th scope="col">{t("colStatus")}</th>
          <th scope="col" className="wide-cell">
            {t("campaignTrigger")}
          </th>
          <th scope="col" className="number-cell">
            {t("resultSent")}
          </th>
          <th scope="col" className="number-cell">
            {t("resultRead")}
          </th>
          <th scope="col" className="number-cell">
            {t("resultReplied")}
          </th>
          <th scope="col" className="number-cell wide-cell">
            {t("resultGoal")}
          </th>
        </tr>
      </thead>
      <tbody>
        {campaigns.map((campaign) => (
          <CampaignRow key={campaign.id} campaign={campaign} onOpen={() => onOpen(campaign.id)} />
        ))}
      </tbody>
    </table>
  );
}

/** Every campaign, by status, with Pause all and the gap between two messages. */
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
  const [filter, setFilter] = useState<Filter>("all");
  const [failure, setFailure] = useState<TextId | null>(null);
  const settings = loadedSettings.data;
  const campaigns = list.data?.campaigns ?? null;
  const saveSettings = async (change: Partial<CampaignSettings>, done: TextId) => {
    if (settings === null) return;
    setFailure(null);
    try {
      loadedSettings.setData(await api.setCampaignSettings({ ...settings, ...change }));
      toast(done);
    } catch (error) {
      setFailure(failureText(error, {}, "actionFailed"));
    }
  };
  const filters: Option<Filter>[] = [
    { value: "all", label: "campaignsAll", count: campaigns?.length ?? 0 },
    ...STATUSES.map((status) => ({
      value: status,
      label: STATUS_TEXT[status],
      count: campaigns?.filter((one) => one.status === status).length ?? 0,
    })),
  ];
  const shown = campaigns?.filter((one) => filter === "all" || one.status === filter) ?? [];
  const newButton = (
    <button type="button" className="pill dark" onClick={() => onOpen(NEW_CAMPAIGN)}>
      <Icon name="plusBold" size={14} />
      {t("campaignNew")}
    </button>
  );
  return (
    <Page title={t("campaigns")} context={t("campaignsContext")} actions={canEdit && newButton}>
      <div className="campaign-list">
        {settings?.paused === true && (
          <PausedBanner
            texts={CAMPAIGNS_PAUSED}
            pausedBy={settings.pausedBy}
            pausedAt={settings.pausedAt}
            onResume={
              canEdit ? () => void saveSettings({ paused: false }, "campaignsResumedToast") : null
            }
          />
        )}
        <ErrorNote text={failure} />
        {campaigns === null ? (
          <Loading failure={list.failure}>
            <TableSkeleton />
          </Loading>
        ) : campaigns.length === 0 ? (
          <div className="nothing empty-boat">
            <EmptyArt scene="day" />
            <b>{t("campaignsEmpty")}</b>
            {t("campaignsEmptyHint")}
            {canEdit && newButton}
          </div>
        ) : (
          <>
            <Choices<Filter>
              label={t("campaignsFilter")}
              variant="tabs"
              value={filter}
              options={filters}
              onChange={setFilter}
            />
            {shown.length === 0 ? (
              <p className="quiet">{t("campaignsNoneHere")}</p>
            ) : (
              <CampaignTable campaigns={shown} onOpen={onOpen} />
            )}
          </>
        )}
        {settings !== null && (
          <AllCampaignsRules settings={settings} canEdit={canEdit} onSave={saveSettings} />
        )}
      </div>
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
