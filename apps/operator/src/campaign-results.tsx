/** @jsxImportSource react */
import {
  addCounts,
  CAMPAIGN_COUNTS,
  type CampaignCount,
  emptyCounts,
} from "../../server/src/campaign-parts.ts";
import { Card, dayName, percent, ShareList, Stat, shareOf, Tipped } from "./analytics.tsx";
import type { Campaign, CampaignCounts, WorkspaceApi } from "./api.ts";
import { useLoad } from "./load.ts";
import { Pond } from "./scene.tsx";
import { AnalyticsSkeleton } from "./skeleton.tsx";
import { plural, type TextId, t } from "./text.ts";
import { Loading } from "./ui.tsx";

/** Each count's column head. */
const COUNT_TEXT: Record<CampaignCount, TextId> = {
  entered: "resultReached",
  sent: "resultSent",
  delivered: "resultDelivered",
  read: "resultRead",
  replied: "resultReplied",
  dismissed: "resultDismissed",
  goalReached: "resultGoal",
  conversationsStarted: "resultConversations",
};

/** Several rows' counts added up, clicks by value too. */
const sum = (rows: CampaignCounts[]): CampaignCounts => rows.reduce(addCounts, emptyCounts());

/** A share of the messages sent, as a number, its percent and a bar. */
function RateStat({ title, count, sent }: { title: TextId; count: number; sent: number }) {
  const share = shareOf(count, sent);
  return (
    <Stat title={title}>
      <p className="stat-value">{percent(share)}</p>
      <p className="stat-note">{t("resultOfSent", { count, sent })}</p>
      <span className="stat-meter" aria-hidden="true">
        <span style={{ width: `${share * 100}%` }} />
      </span>
    </Stat>
  );
}

/** One row per day or per variant, with each count. */
function CountsTable({
  head,
  rows,
}: {
  head: TextId;
  rows: { name: string; counts: CampaignCounts }[];
}) {
  return (
    <div className="table-scroll">
      <table className="members results-table">
        <thead>
          <tr>
            <th scope="col">{t(head)}</th>
            {CAMPAIGN_COUNTS.map((count) => (
              <th key={count} scope="col" className="number-cell">
                {t(COUNT_TEXT[count])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row">{row.name}</th>
              {CAMPAIGN_COUNTS.map((count) => (
                <td key={count} className="number-cell">
                  {row.counts[count]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Button choices by value, most first, each as a share of every choice. */
function Clicks({ clicks }: { clicks: Record<string, number> }) {
  const values = Object.entries(clicks).sort(([, one], [, other]) => other - one);
  return (
    <ShareList
      title="resultClicks"
      empty="resultNoClicks"
      total={values.reduce((all, [, count]) => all + count, 0)}
      rows={values.map(([value, count]) => ({
        key: value,
        name: <span className="mono">{value}</span>,
        count,
      }))}
    />
  );
}

/** A campaign's results per day and per variant, in the style of Analytics. */
export function CampaignResultsView({ api, campaign }: { api: WorkspaceApi; campaign: Campaign }) {
  const loaded = useLoad(() => api.campaignResults(campaign.id), [api, campaign]);
  const results = loaded.data;
  if (results === null) {
    return (
      <Loading failure={loaded.failure}>
        <AnalyticsSkeleton />
      </Loading>
    );
  }
  if (results.days.length === 0) {
    return (
      <div className="nothing empty-boat">
        <Pond />
        <b>{t("resultsEmpty")}</b>
        {t("resultsEmptyHint")}
      </div>
    );
  }
  const total = sum(results.variants);
  const days = [...new Set(results.days.map((one) => one.day))].sort().reverse();
  const hasVariants = results.variants.some((one) => one.variant !== null);
  return (
    <Tipped className="analytics">
      <section className="stats" aria-label={t("statsTitle")}>
        <Stat title="resultSent">
          <p className="stat-value">{total.sent}</p>
          <p className="stat-note">
            {plural(total.entered, "resultEnteredOne", "resultEnteredMany")}
          </p>
        </Stat>
        <RateStat title="resultRead" count={total.read} sent={total.sent} />
        <RateStat title="resultReplied" count={total.replied} sent={total.sent} />
        <RateStat title="resultGoal" count={total.goalReached} sent={total.sent} />
      </section>
      <div className="charts results-charts">
        <Card title="resultPerDay">
          <CountsTable
            head="resultDay"
            rows={days.map((day) => ({
              name: dayName(day, { weekday: "short", month: "short", day: "numeric" }),
              counts: sum(results.days.filter((one) => one.day === day)),
            }))}
          />
        </Card>
        {hasVariants && (
          <Card title="resultPerVariant">
            <CountsTable
              head="resultVariant"
              rows={results.variants.map((one) => ({ name: one.variant ?? "", counts: one }))}
            />
          </Card>
        )}
        <Clicks clicks={total.clicks} />
      </div>
    </Tipped>
  );
}
