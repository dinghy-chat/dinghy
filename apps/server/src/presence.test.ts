import { randomUUID } from "node:crypto";
import { Redis } from "iovalkey";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { VALKEY_URL } from "../test/env.ts";
import { createPresence } from "./presence.ts";

const logger = pino({ level: "silent" });
const connections: Redis[] = [];
function connect(): Redis {
  const client = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  connections.push(client);
  return client;
}

// Two connections and two objects, as two server instances have.
let first: ReturnType<typeof createPresence>;
let second: ReturnType<typeof createPresence>;

beforeAll(() => {
  first = createPresence(connect(), logger);
  second = createPresence(connect(), logger);
});

afterAll(() => {
  for (const client of connections) client.disconnect();
});

const space = () => randomUUID();

describe("across two instances", () => {
  test("each instance sees what the other wrote", async () => {
    const workspace = space();
    const conversation = randomUUID();
    const anna = randomUUID();
    const ben = randomUUID();
    await first.beat(workspace, anna, conversation, null);
    const state = await second.beat(workspace, ben, conversation, null);
    expect(state?.viewers[conversation]?.sort()).toEqual([anna, ben].sort());
    expect(await first.online(workspace)).toBe(true);
    expect(await second.online(workspace)).toBe(true);
  });

  test("a leave on one instance clears it for the other", async () => {
    const workspace = space();
    const conversation = randomUUID();
    const anna = randomUUID();
    await first.beat(workspace, anna, conversation, null);
    await second.leave(workspace, anna, conversation);
    expect(await first.online(workspace)).toBe(false);
    const state = await first.beat(workspace, randomUUID(), null, null);
    expect(state?.viewers).toEqual({});
  });
});

describe("clearing", () => {
  test("an operator who disconnects with no goodbye expires", async () => {
    const short = createPresence(connect(), logger, 100);
    const workspace = space();
    const conversation = randomUUID();
    await short.beat(workspace, randomUUID(), conversation, null);
    expect(await short.online(workspace)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Nothing removed the entry, and the time alone ends it.
    expect(await short.online(workspace)).toBe(false);
    const state = await short.beat(workspace, randomUUID(), null, null);
    expect(state?.viewers).toEqual({});
  });

  test("a heartbeat keeps an operator present past the first expiry", async () => {
    const short = createPresence(connect(), logger, 200);
    const workspace = space();
    const anna = randomUUID();
    const conversation = randomUUID();
    await short.beat(workspace, anna, conversation, null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await short.beat(workspace, anna, conversation, null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await short.online(workspace)).toBe(true);
  });

  test("moving to another conversation leaves the first", async () => {
    const workspace = space();
    const anna = randomUUID();
    const one = randomUUID();
    const two = randomUUID();
    await first.beat(workspace, anna, one, null);
    const state = await first.beat(workspace, anna, two, one);
    expect(state?.viewers).toEqual({ [two]: [anna] });
  });

  test("leaving one conversation with the app still open stays online", async () => {
    const workspace = space();
    const anna = randomUUID();
    const one = randomUUID();
    await first.beat(workspace, anna, one, null);
    const state = await first.beat(workspace, anna, null, one);
    expect(state?.viewers).toEqual({});
    expect(await first.online(workspace)).toBe(true);
  });

  test("a workspace that everyone left does not keep its key", async () => {
    const client = connect();
    const short = createPresence(client, logger, 50);
    const workspace = space();
    await short.beat(workspace, randomUUID(), null, null);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(await client.exists(`dinghy:presence:${workspace}`)).toBe(0);
  });
});

test("one workspace sees nothing from another", async () => {
  const one = space();
  const two = space();
  const conversation = randomUUID();
  await first.beat(one, randomUUID(), conversation, null);
  expect(await first.online(two)).toBe(false);
  const state = await first.beat(two, randomUUID(), null, null);
  expect(state?.viewers).toEqual({});
});

describe("with Valkey down", () => {
  test("no Valkey means unknown, and nothing throws", async () => {
    const none = createPresence(null, logger);
    expect(await none.online(space())).toBeNull();
    expect(await none.beat(space(), randomUUID(), null, null)).toBeNull();
    await expect(none.leave(space(), randomUUID(), null)).resolves.toBeUndefined();
  });

  test("a failing Valkey means unknown, and nothing throws", async () => {
    const broken = new Redis("redis://127.0.0.1:1", {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    broken.on("error", () => {});
    connections.push(broken);
    const presence = createPresence(broken, logger);
    expect(await presence.online(space())).toBeNull();
    expect(await presence.beat(space(), randomUUID(), null, null)).toBeNull();
  });
});
