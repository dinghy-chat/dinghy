import { describe, expect, test } from "vitest";
import { groupMeta } from "./thread-line.tsx";
import type { Line } from "./thread-lines.ts";

const at = "2026-11-19T20:12:00.000Z";

/** An outbound message from a key, as the thread receives it. */
const outbound = (sender: Line["sender"]) =>
  ({
    id: "m1",
    status: "sent",
    fromVisitor: false,
    kind: "text",
    createdAt: at,
    editedAt: null,
    deleted: false,
    authorOperatorId: null,
    authorApiKeyId: "k1",
    authorName: "Welcome bot",
    outboundId: "o1",
    sender,
  }) as Line;

describe("the line under an outbound message", () => {
  test("names the key and the person the visitor saw, in one line", () => {
    const line = outbound({ operatorId: "julien", name: "Julien" });
    expect(groupMeta([line], 0, "me")).toMatch(/^Sent as Julien by Welcome bot · /);
  });

  test("names only the key when the visitor saw the key", () => {
    expect(groupMeta([outbound(null)], 0, "me")).toMatch(/^Welcome bot · /);
  });

  test("shows on each one, even in a run from the same key", () => {
    const lines = [outbound(null), { ...outbound(null), id: "m2" }];
    expect(groupMeta(lines, 0, "me")).not.toBeNull();
  });
});
