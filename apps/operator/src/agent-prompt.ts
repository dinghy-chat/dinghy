import { t } from "./text.ts";

/** The coding agents the Install page has a prompt for. Other is any client that speaks MCP. */
export type AgentClient = "claude" | "cursor" | "other";

/** How each client adds Dinghy's MCP server, and how the person approves it. */
function connectSteps(client: AgentClient, url: string) {
  if (client === "claude") {
    const command = `claude mcp add --transport http dinghy ${url}`;
    return { connect: t("agentConnectClaude", { command }), approve: t("agentApproveClaude") };
  }
  if (client === "cursor") {
    // Indented under its step, as the prompt shows it.
    const config = JSON.stringify({ mcpServers: { dinghy: { url } } }, null, 2).replace(
      /^/gm,
      "   ",
    );
    return { connect: t("agentConnectCursor", { config }), approve: t("agentApproveCursor") };
  }
  return { connect: t("agentConnectOther", { url }), approve: t("agentApproveOther") };
}

/** The prompt that has a coding agent install the chat through MCP, in the words of its client. */
export function agentPrompt(origin: string, workspace: string, client: AgentClient) {
  const url = `${origin}/v1/mcp`;
  return t("agentPrompt", { workspace, ...connectSteps(client, url) });
}
