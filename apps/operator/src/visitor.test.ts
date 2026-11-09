import { describe, expect, test } from "vitest";
import type { Conversation } from "./api.ts";
import { isWaiting, otherIdentity, visitorLabel, visitorName, webLink } from "./visitor.ts";

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
    const named = (email: string | null, externalId: string | null) =>
      visitorName({ id, name: null, email, externalId });
    expect(named("a@example.com", "u1")).toBe("a@example.com");
    expect(named(null, "u1")).toBe("u1");
    expect(named(null, null)).toBe(visitorLabel(id));
  });
});

describe("waiting", () => {
  const base: Conversation = {
    id: "c",
    status: "open",
    updatedAt: "2026-11-07T10:00:00.000Z",
    assigneeOperatorId: null,
    startedPage: null,
    visitor: {
      id: "v",
      email: null,
      externalId: null,
      name: null,
      attributes: null,
      blocked: false,
      device: null,
      lastPage: null,
      lastSeenAt: null,
    },
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

describe("names and links", () => {
  test("a signed name comes before the email and the user ID", () => {
    expect(visitorName({ id: "v", name: "Ana", email: "a@example.com", externalId: "u1" })).toBe(
      "Ana",
    );
    expect(visitorName({ id: "v", name: null, email: "a@example.com", externalId: "u1" })).toBe(
      "a@example.com",
    );
  });

  test("only an http or https address that parses becomes a link", () => {
    expect(webLink("https://acme.example/account/42")).toBe("https://acme.example/account/42");
    expect(webLink("HTTP://acme.example")).toBe("http://acme.example/");
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://acme.example",
      "https://",
      " https://acme.example",
      "acme.example",
      42,
      null,
      { url: "https://acme.example" },
    ]) {
      expect(webLink(value)).toBeNull();
    }
  });
});

describe("the line under the visitor's name", () => {
  test("keeps the email and the user ID that the title does not show", () => {
    expect(otherIdentity({ name: "Ana", email: "ana@example.com", externalId: "u-1" })).toEqual([
      "ana@example.com",
      "u-1",
    ]);
    expect(otherIdentity({ name: null, email: "ana@example.com", externalId: "u-1" })).toEqual([
      "u-1",
    ]);
    expect(otherIdentity({ name: "Ana", email: null, externalId: "u-1" })).toEqual(["u-1"]);
    expect(otherIdentity({ name: null, email: null, externalId: "u-1" })).toEqual([]);
    expect(otherIdentity({ name: null, email: null, externalId: null })).toEqual([]);
  });
});
