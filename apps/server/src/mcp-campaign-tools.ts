import { z } from "@hono/zod-openapi";
import {
  CAMPAIGN_REFUSALS,
  CAMPAIGN_SEND_REFUSALS,
  CampaignDefinitionSchema,
  CampaignKey,
  CampaignListQuery,
  type CampaignRefusal,
  CampaignSendSchema,
  ResultsQuery,
} from "./campaign-schemas.ts";
import type { CampaignRef, Campaigns } from "./campaigns.ts";
import { failure, NOT_FOUND, zodFailure } from "./errors.ts";
import { type Outcome, type Tool, tool } from "./mcp.ts";
import { type Tracking, TrackSchema } from "./track.ts";

// Campaigns through MCP: every key reads them, sends them and tracks events, and a Setup key also
// saves, starts, pauses and ends them, as on the REST API.

const Ref = z.object({
  id: z.uuid().optional().describe("The campaign's ID, from list_campaigns"),
  key: CampaignKey.optional().describe("The campaign's key, such as onboarding-done"),
});

const ONE_REF = failure("invalid_request", "Pass exactly one of id and key.");

/** The campaign a tool's input names, or null when it names none or both. */
const refFromInput = ({ id, key }: z.infer<typeof Ref>): CampaignRef | null =>
  id !== undefined && key === undefined
    ? { id }
    : key !== undefined && id === undefined
      ? { key }
      : null;

const refused = (refusal: CampaignRefusal | z.ZodError): Outcome => ({
  error: refusal instanceof z.ZodError ? zodFailure(refusal) : CAMPAIGN_REFUSALS[refusal].body,
});

/** A tool on one campaign, by ID or key. */
function onCampaign<S extends z.ZodObject>(
  spec: Omit<Parameters<typeof tool<S>>[0], "run"> & {
    run(ref: CampaignRef, input: z.output<S>, workspaceId: string): Promise<Outcome>;
  },
): Tool {
  return tool({
    ...spec,
    input: spec.input,
    run(input, { workspaceId }) {
      const ref = refFromInput(input as z.infer<typeof Ref>);
      return ref === null ? Promise.resolve({ error: ONE_REF }) : spec.run(ref, input, workspaceId);
    },
  });
}

const STATUS_TOOLS = {
  pause: "Pauses a live campaign: its waiting messages wait, and it makes no new ones.",
  resume: "Starts a draft campaign, or resumes a paused one.",
  end: "Ends a campaign for good, and cancels its messages that wait. It cannot start again.",
} as const;

export function campaignTools({
  campaigns,
  tracking,
}: {
  campaigns: Campaigns;
  tracking: Tracking;
}): { everyKey: Tool[]; setupOnly: Tool[] } {
  const everyKey = [
    tool({
      name: "list_campaigns",
      title: "List campaigns",
      description:
        "Lists the campaigns, oldest first, each with its `status` (draft, live, paused or ended), its `definition` (the JSON that upsert_campaign takes) and its `totals` since it started.",
      input: CampaignListQuery,
      readOnly: true,
      run: async ({ status }, { workspaceId }) => ({
        data: { campaigns: await campaigns.list(workspaceId, status) },
      }),
    }),
    onCampaign({
      name: "get_campaign",
      title: "Read a campaign",
      description: "Reads one campaign by `id` or `key`, with its definition and totals.",
      input: Ref,
      readOnly: true,
      async run(ref, _input, workspaceId) {
        const found = await campaigns.get(workspaceId, ref);
        return found === null ? { error: NOT_FOUND } : { data: { campaign: found } };
      },
    }),
    onCampaign({
      name: "get_campaign_results",
      title: "Read a campaign's results",
      description:
        "A campaign's results per day in UTC and per A/B variant, by `id` or `key`, between `from` and `to` (YYYY-MM-DD): contacts reached, messages sent, delivered, read, replied and dismissed, clicks by button value, goals reached and conversations started.",
      input: Ref.extend(ResultsQuery.shape),
      readOnly: true,
      async run(ref, { from, to }, workspaceId) {
        const found = await campaigns.results(workspaceId, ref, { from, to });
        return found === null ? { error: NOT_FOUND } : { data: found };
      },
    }),
    onCampaign({
      name: "send_campaign",
      title: "Send a campaign to one person",
      description:
        "Runs a live campaign for one person, by `id` or `key`: `visitor` is `{ userId, name?, email?, attributes? }`, which creates or updates them, or `{ id }`. It skips the audience and the trigger, and keeps the frequency and the visitor's opt-out. `data` fills `{{ data.<key> }}` in the text. A retry with the same `clientId`, and a send the frequency keeps out, answer the message that is there. Errors: `campaign_not_live`, `opted_out`, `blocked`, `too_many_waiting`.",
      input: Ref.extend(CampaignSendSchema.shape),
      idempotent: true,
      async run(ref, { clientId, visitor, data }, workspaceId) {
        const outcome = await campaigns.send(workspaceId, ref, { clientId, visitor, data });
        if (typeof outcome === "string") return { error: CAMPAIGN_SEND_REFUSALS[outcome].body };
        return { data: { outboundMessage: outcome.outboundMessage } };
      },
    }),
    tool({
      name: "track_event",
      title: "Track an event about a contact",
      description:
        'Counts the event `name` (such as `export.finished`) on the contact that `visitor` names, which it creates or updates. Conditions read `events.<name>.count` and `events.<name>.lastAt`, and a live campaign with the trigger `{ type: "event", name }` runs for them, with `properties` in its text. Properties are never stored. A repeat of a recent `id` counts once: the answer\'s `counted` is false.',
      input: TrackSchema,
      idempotent: true,
      async run(input, { workspaceId }) {
        const outcome = await tracking.track(workspaceId, input);
        return outcome === null ? { error: NOT_FOUND } : { data: outcome };
      },
    }),
  ];
  const setupOnly = [
    tool({
      name: "upsert_campaign",
      title: "Create or replace a campaign",
      description:
        'Saves a campaign by its `definition.key`: a new one as a draft, or over the one with that key, whose status stays. The definition holds `key`, `name`, `audience` (a condition), `trigger` (`match`, `schedule`, `event`, `page` or `api`), `message` (`sender`, `body` with variables such as `{{ firstName | default: "there" }}`, `buttons` each with a `value`, `translations` per language), `presentation` (`startConversation`, `show`, `ifConversationOpen`), `delivery`, `rules` (`frequency`, `businessHours`, `sendWindow`, `endsAt`, `exitWhen`, `goal`) and `variants`. Start it with resume_campaign.',
      input: z.object({ definition: CampaignDefinitionSchema }),
      idempotent: true,
      async run({ definition }, { workspaceId, actor }) {
        const outcome = await campaigns.upsert(workspaceId, actor, definition);
        if (typeof outcome === "string" || outcome instanceof z.ZodError) return refused(outcome);
        return { data: { campaign: outcome.view, created: outcome.created } };
      },
    }),
    ...Object.entries(STATUS_TOOLS).map(([action, description]) =>
      onCampaign({
        name: `${action}_campaign`,
        title: `${action[0]?.toUpperCase()}${action.slice(1)} a campaign`,
        description: `${description} By \`id\` or \`key\`.`,
        input: Ref,
        idempotent: true,
        destructive: action === "end",
        async run(ref, _input, workspaceId) {
          const outcome = await campaigns.setStatus(
            workspaceId,
            ref,
            action as keyof typeof STATUS_TOOLS,
          );
          return typeof outcome === "string" ? refused(outcome) : { data: { campaign: outcome } };
        },
      }),
    ),
  ];
  return { everyKey, setupOnly };
}
