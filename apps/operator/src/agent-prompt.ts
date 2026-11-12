import { t } from "./text.ts";

/** The MCP server's address, the command that adds it to Claude Code, and the JSON for others. */
function mcpSetup(origin: string) {
  const url = `${origin}/v1/mcp`;
  return {
    url,
    command: `claude mcp add --transport http dinghy ${url}`,
    // Indented under its step, as the prompt shows it.
    config: JSON.stringify({ mcpServers: { dinghy: { type: "http", url } } }, null, 2).replace(
      /^/gm,
      "   ",
    ),
  };
}

/**
 * The prompt that has a coding agent install the chat through MCP. Its last step adds `notes`, the
 * block for the site repository's AGENTS.md.
 */
export function agentTexts(origin: string, workspace: string) {
  const mcp = mcpSetup(origin);
  const notes = t("agentNotes", { url: mcp.url });
  return { prompt: t("agentPrompt", { workspace, ...mcp, notes }), notes };
}
