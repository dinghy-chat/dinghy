/** @jsxImportSource react */
import type { Campaign, ContactFields, WorkspaceApi } from "./api.ts";
import { namesRead } from "./campaign-conditions.ts";
import { useLoad } from "./load.ts";
import { TableSkeleton } from "./skeleton.tsx";
import { type TextId, t } from "./text.ts";
import { Loading } from "./ui.tsx";
import { ago } from "./visitor.ts";

// The Contacts page's "Attributes and events": the names your app sends about contacts, how many
// of them have each, and the campaigns that read it, so a typo or an unused name shows.

interface NameRow {
  name: string;
  contacts: number;
  /** When one of those contacts was last seen, or last did the event. */
  at: string;
}

/** The names of the campaigns, not ended, that read each attribute and each event. */
function usedIn(campaigns: Campaign[]) {
  const attributes = new Map<string, string[]>();
  const events = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, name: string, campaign: string) =>
    map.set(name, [...(map.get(name) ?? []), campaign]);
  for (const { status, definition } of campaigns) {
    if (status === "ended") continue;
    const read = namesRead(definition);
    for (const name of read.attributes) add(attributes, name, definition.name);
    for (const name of read.events) add(events, name, definition.name);
  }
  return { attributes, events };
}

function NameTable({
  title,
  empty,
  atLabel,
  rows,
  usedBy,
}: {
  title: TextId;
  empty: TextId;
  atLabel: TextId;
  rows: NameRow[];
  usedBy: Map<string, string[]>;
}) {
  return (
    <section className="contact-data" aria-label={t(title)}>
      <h3>{t(title)}</h3>
      {rows.length === 0 ? (
        <p className="hint">{t(empty)}</p>
      ) : (
        <table className="members">
          <thead>
            <tr>
              <th scope="col">{t("colName")}</th>
              <th scope="col" className="number-cell">
                {t("contacts")}
              </th>
              <th scope="col">{t(atLabel)}</th>
              <th scope="col" className="wide-cell">
                {t("contactDataUsedIn")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>
                  <code>{row.name}</code>
                </td>
                <td className="number-cell">{row.contacts.toLocaleString()}</td>
                <td>
                  <time dateTime={row.at}>{ago(row.at)}</time>
                </td>
                <td className="wide-cell">
                  {usedBy.get(row.name)?.join(", ") ?? (
                    <span className="quiet">{t("contactDataUnused")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function NameTables({ fields, campaigns }: { fields: ContactFields; campaigns: Campaign[] }) {
  const used = usedIn(campaigns);
  return (
    <>
      <NameTable
        title="contactDataAttributes"
        empty="contactDataNoAttributes"
        atLabel="sortLastSeen"
        rows={fields.attributes.map(({ lastSeenAt, ...row }) => ({ ...row, at: lastSeenAt }))}
        usedBy={used.attributes}
      />
      <NameTable
        title="contactDataEvents"
        empty="contactDataNoEvents"
        atLabel="contactDataLastTime"
        rows={fields.events.map(({ lastAt, ...row }) => ({ ...row, at: lastAt }))}
        usedBy={used.events}
      />
    </>
  );
}

/** The attributes and events of the contacts seen last, each with the campaigns that read it. */
export function ContactData({ api }: { api: WorkspaceApi }) {
  const fields = useLoad(() => api.contactFields(), [api]);
  const campaigns = useLoad(() => api.campaigns(), [api]);
  return (
    <>
      <p className="hint">{t("contactDataHelp")}</p>
      {fields.data === null || campaigns.data === null ? (
        <Loading failure={fields.failure ?? campaigns.failure}>
          <TableSkeleton />
        </Loading>
      ) : (
        <NameTables fields={fields.data} campaigns={campaigns.data.campaigns} />
      )}
    </>
  );
}
