import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentClient, agentPrompt } from "./agent-prompt.ts";
import { t } from "./text.ts";

const ORIGIN = "https://chat.example.com";
const MCP_URL = `${ORIGIN}/v1/mcp`;
const notes = t("agentNotes", { url: MCP_URL });
const CLIENTS: AgentClient[] = ["claude", "cursor", "other"];

test("each client's prompt names every install step and the safety lines", () => {
  for (const client of CLIENTS) {
    const prompt = agentPrompt(ORIGIN, "Acme", client);
    expect(prompt).toContain('the workspace "Acme"');
    expect(prompt).toContain("Full access");
    for (const tool of [
      "get_install_snippet",
      "add_allowed_site",
      "remove_allowed_site",
      "verify_install",
    ]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain("at most 5 times");
    expect(prompt).toContain("Ask me before you change anything outside the install.");
    // Every placeholder is filled.
    expect(prompt).not.toMatch(/\{\w+\}/);
  }
});

test("each client connects to this server's MCP in its own way", () => {
  expect(agentPrompt(ORIGIN, "Acme", "claude")).toContain(
    `claude mcp add --transport http dinghy ${MCP_URL}`,
  );
  expect(agentPrompt(ORIGIN, "Acme", "claude")).toContain("/mcp");
  const cursor = agentPrompt(ORIGIN, "Acme", "cursor");
  expect(cursor).toContain(".cursor/mcp.json");
  expect(cursor).toContain(`"url": "${MCP_URL}"`);
  expect(cursor).not.toContain("claude mcp add");
  const other = agentPrompt(ORIGIN, "Acme", "other");
  expect(other).toContain(`remote HTTP MCP server, at ${MCP_URL}`);
  expect(other).toContain("approve it in the browser");
});

test("the prompt ends its steps with the AGENTS.md block, and a name with $ shows as typed", () => {
  const prompt = agentPrompt(ORIGIN, "R$$D", "claude");
  expect(notes).toContain(MCP_URL);
  expect(notes).toContain("hand_off");
  expect(notes).not.toMatch(/\{\w+\}/);
  expect(prompt).toContain(notes);
  expect(prompt).toContain('"R$$D"');
});

test("docs/agents.md holds the same AGENTS.md block", () => {
  const docs = readFileSync(new URL("../../../docs/agents.md", import.meta.url), "utf8");
  expect(docs).toContain(notes);
});
