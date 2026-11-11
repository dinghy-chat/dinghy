import { describe, expect, test } from "vitest";
import type { Conversation } from "./api.ts";
import {
  detailRows,
  isWaiting,
  presenceLine,
  replyAuthor,
  visitorLabel,
  visitorName,
  webLink,
} from "./visitor.ts";

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
    pageContext: null,
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
      country: null,
      timeZone: null,
    },
    lastMessage: { body: "hi", fromVisitor: true, createdAt: "2026-11-07T10:00:00.000Z" },
    welcome: false,
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
  test("says the chat is open, or when the visitor was last seen, or nothing", () => {
    expect(presenceLine(null, true)).toBe("Chat is open");
    expect(presenceLine(new Date().toISOString(), false)).toMatch(/^Last seen /);
    expect(presenceLine(null, null)).toBeNull();
  });
});

describe("details and authors", () => {
  test("a record's values show as text, and only a web address becomes a link", () => {
    expect(
      detailRows({ plan: "pro", seats: 3, trial: false, note: null, site: "https://a.example/x" }),
    ).toEqual([
      ["plan", "pro", null],
      ["seats", "3", null],
      ["trial", "false", null],
      ["note", "null", null],
      ["site", "https://a.example/x", "https://a.example/x"],
    ]);
    expect(detailRows(null)).toEqual([]);
  });

  test("a reply from an API key shows its name, never You", () => {
    const reply = { authorOperatorId: null, authorApiKeyId: "k", authorName: "Support bot" };
    expect(replyAuthor(reply, "me")).toBe("Support bot (automated reply)");
    expect(replyAuthor({ ...reply, authorApiKeyId: null, authorOperatorId: "me" }, "me")).toBe(
      "You",
    );
    expect(
      replyAuthor({ authorOperatorId: "x", authorApiKeyId: null, authorName: null }, "me"),
    ).toBe("A teammate");
  });
});
