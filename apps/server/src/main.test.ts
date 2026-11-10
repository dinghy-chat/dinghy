import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createTestDatabase } from "../test/database.ts";
import { AUTH_SECRET, DATABASE_URL, PUBLIC_URL, VALKEY_URL } from "../test/env.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

function start(role: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [MAIN, role], {
    env: {
      ...process.env,
      DATABASE_URL,
      WORKER_DATABASE_URL: DATABASE_URL,
      VALKEY_URL,
      AUTH_SECRET,
      PUBLIC_URL,
      PORT: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

async function waitFor(output: () => string, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!output().includes(text)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${text}": ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", resolve));
}

describe.each([
  { role: "web", started: "listening" },
  { role: "worker", started: "worker started" },
  { role: "all", started: "worker started" },
])("the $role role", ({ role, started }) => {
  test("starts and stops cleanly", async () => {
    const { child, output } = start(role);
    await waitFor(output, started);
    const exited = exitCode(child);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(output()).toContain('"msg":"stopped"');
  }, 15_000);
});

test("the web role serves readiness against real services", async () => {
  const { child, output } = start("web");
  await waitFor(output, "listening");
  const port = JSON.parse(
    output()
      .split("\n")
      .find((line) => line.includes("listening")) ?? "{}",
  ).port as number;
  await expect
    .poll(async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).status, {
      timeout: 5000,
    })
    .toBe(200);
  const exited = exitCode(child);
  child.kill("SIGTERM");
  await exited;
}, 15_000);

test("the web role reports not ready when Postgres is down", async () => {
  const { child, output } = start("web", { DATABASE_URL: "postgres://x@127.0.0.1:1/x" });
  await waitFor(output, "listening");
  const port = JSON.parse(
    output()
      .split("\n")
      .find((line) => line.includes("listening")) ?? "{}",
  ).port as number;
  const response = await fetch(`http://127.0.0.1:${port}/readyz`);
  expect(response.status).toBe(503);
  const exited = exitCode(child);
  child.kill("SIGTERM");
  await exited;
}, 15_000);

test("an unknown role exits with a usage error", async () => {
  const { child } = start("nonsense");
  expect(await exitCode(child)).toBe(2);
});

test("a missing setting stops the start", async () => {
  const { child } = start("web", { DATABASE_URL: "" });
  expect(await exitCode(child)).not.toBe(0);
});

test("the web role refuses to start when the welcome operator is not in the welcome workspace", async () => {
  const database = await createTestDatabase();
  await database.migrate();
  try {
    const { child, output } = start("web", {
      DATABASE_URL: database.url("app"),
      CLOUD_SIGNUP: "early",
      CLOUD_WELCOME_WORKSPACE_ID: crypto.randomUUID(),
      CLOUD_WELCOME_OPERATOR_EMAIL: "nobody@example.com",
    });
    expect(await exitCode(child)).toBe(2);
    expect(output()).toContain(
      "CLOUD_WELCOME_OPERATOR_EMAIL is not an active member of CLOUD_WELCOME_WORKSPACE_ID",
    );
  } finally {
    await database.drop();
  }
}, 30_000);
