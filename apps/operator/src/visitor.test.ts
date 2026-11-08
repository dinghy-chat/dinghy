import { describe, expect, test } from "vitest";
import type { Conversation } from "./api.ts";
import { isWaiting, visitorLabel, visitorName } from "./visitor.ts";

describe("visitor labels", () => {
  test("a signed-out visitor gets a short code from its ID, the same every time", () => {
    const id = "7f3a9c2e-1b4d-4e8f-9a0b-1c2d3e4f5a6b";
    expect(visitorLabel(id)).toMatch(/^Visitor [0-9A-HJKMNP-TV-Z]{4}$/);
    expect(visitorLabel(id)).toBe(visitorLabel(id));
  });

  test("two visitors get different codes", () => {
    const labels = new Set(
      ["00000000", "7f3a9c2e", "7f3b9c2e", "ffffffff", "12345678"].map((start) =>
        visitorLabel(`${start}-1b4d-4e8f-9a0b-1c2d3e4f5a6b`),
      ),
    );
    expect(labels.size).toBe(5);
  });

  test("an email or a user ID from the host site comes first", () => {
    const id = "7f3a9c2e-1b4d-4e8f-9a0b-1c2d3e4f5a6b";
    expect(visitorName({ id, email: "a@example.com", externalId: "u1" })).toBe("a@example.com");
    expect(visitorName({ id, email: null, externalId: "u1" })).toBe("u1");
    expect(visitorName({ id, email: null, externalId: null })).toBe(visitorLabel(id));
  });
});

describe("waiting", () => {
  const base: Conversation = {
    id: "c",
    status: "open",
    updatedAt: "2026-11-07T10:00:00.000Z",
    assigneeOperatorId: null,
    startedPage: null,
    visitor: { id: "v", email: null, externalId: null, claims: null, blocked: false },
    lastMessage: { body: "hi", fromVisitor: true, createdAt: "2026-11-07T10:00:00.000Z" },
  };

  test("an open conversation whose newest message is the visitor's waits", () => {
    expect(isWaiting(base)).toBe(true);
  });

  test("a reply, a closed conversation or no message does not wait", () => {
    const reply = { body: "ok", fromVisitor: false, createdAt: base.updatedAt };
    expect(isWaiting({ ...base, lastMessage: reply })).toBe(false);
    expect(isWaiting({ ...base, status: "closed" })).toBe(false);
    expect(isWaiting({ ...base, lastMessage: null })).toBe(false);
  });
});
