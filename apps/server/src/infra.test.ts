import { Redis } from "iovalkey";
import pg from "pg";
import { expect, test } from "vitest";
import { DATABASE_URL, VALKEY_URL } from "../test/env.ts";

test("Postgres answers a query", async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ answer: number }>("select 1 as answer");
    expect(result.rows[0]?.answer).toBe(1);
  } finally {
    await client.end();
  }
});

test("Valkey answers a ping", async () => {
  const client = new Redis(VALKEY_URL);
  try {
    expect(await client.ping()).toBe("PONG");
  } finally {
    client.disconnect();
  }
});
