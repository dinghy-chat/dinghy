/** @jsxImportSource react */
import { Card, dayName, percent, ShareList, Stat, shareOf, Tipped } from "./analytics.tsx";
import type { Campaign, CampaignCounts, WorkspaceApi } from "./api.ts";
import { useLoad } from "./load.ts";
import { Pond } from "./scene.tsx";
import { AnalyticsSkeleton } from "./skeleton.tsx";
import { plural, type TextId, t } from "./text.ts";
import { Loading } from "./ui.tsx";

type Count = Exclude<keyof CampaignCounts, "clicks">;

/** The counts a table shows, in the order a message goes through them. */
const COLUMNS: { count: Count; label: TextId }[] = [
  { count: "entered", label: "resultReached" },
  { count: "sent", label: "resultSent" },
  { count: "delivered", label: "resultDelivered" },
  { count: "read", label: "resultRead" },
  { count: "replied", label: "resultReplied" },
  { count: "dismissed", label: "resultDismissed" },
  { count: "goalReached", label: "resultGoal" },
  { count: "conversationsStarted", label: "resultConversations" },
];

const COUNTS = COLUMNS.map((column) => column.count);

/** Several rows' counts added up, clicks by value too. */
function sum(rows: CampaignCounts[]): CampaignCounts {
  const total: CampaignCounts = {
    ...(Object.fromEntries(COUNTS.map((count) => [count, 0])) as Record<Count, number>),
    clicks: {},
  };
  for (const row of rows) {
    for (const count of COUNTS) total[count] += row[count];
    for (const [value, clicks] of Object.entries(row.clicks)) {
      total.clicks[value] = (total.clicks[value] ?? 0) + clicks;
    }
  }
  return total;
}

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
            {COLUMNS.map((column) => (
              <th key={column.count} scope="col" className="number-cell">
                {t(column.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row">{row.name}</th>
              {COLUMNS.map((column) => (
                <td key={column.count} className="number-cell">
                  {row.counts[column.count]}
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
