import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { agentTexts } from "./agent-prompt.ts";

const ORIGIN = "https://chat.example.com";

test("the prompt connects to this server's MCP and names every setup step", () => {
  const { prompt } = agentTexts(ORIGIN, "Acme");
  expect(prompt).toContain(
    "claude mcp add --transport http dinghy https://chat.example.com/v1/mcp",
  );
  expect(prompt).toContain('"url": "https://chat.example.com/v1/mcp"');
  expect(prompt).toContain('the workspace "Acme"');
  for (const tool of [
    "get_install_snippet",
    "add_allowed_site",
    "remove_allowed_site",
    "verify_install",
    "get_identity_setup",
    "send_test_message",
    "delete_test_visitors",
  ]) {
    expect(prompt).toContain(tool);
  }
  expect(prompt).toContain("Ask me before you change anything outside the install.");
  // Every placeholder is filled.
  expect(prompt).not.toMatch(/\{\w+\}/);
});

test("the prompt ends its steps with the AGENTS.md block, and a name with $ shows as typed", () => {
  const { prompt, notes } = agentTexts(ORIGIN, "R$$D");
  expect(notes).toContain("https://chat.example.com/v1/mcp");
  expect(notes).toContain("hand_off");
  expect(notes).not.toMatch(/\{\w+\}/);
  expect(prompt).toContain(notes);
  expect(prompt).toContain('"R$$D"');
});

test("docs/agents.md holds the same AGENTS.md block", () => {
  const docs = readFileSync(new URL("../../../docs/agents.md", import.meta.url), "utf8");
  expect(docs).toContain(agentTexts(ORIGIN, "Acme").notes);
});
