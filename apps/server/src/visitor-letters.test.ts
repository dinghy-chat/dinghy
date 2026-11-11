import { describe, expect, test } from "vitest";
import { replyLetter } from "./alerts.ts";
import { transcriptLetter } from "./transcripts.ts";

const links = { chatUrl: "https://chat.example.com/chat/t", stopUrl: "https://chat.example.com/s" };

describe("the reply email", () => {
  test("shows each reply under its quote, Markdown as typed in text and formatted in HTML", () => {
    const quote = {
      id: "q1",
      authorName: null,
      fromVisitor: true,
      excerpt: "Where is my order?",
      hasImage: false,
    };
    const letter = replyLetter(
      "Acme",
      [
        { body: "It ships **today**.", quote },
        { body: null, quote: null },
      ],
      links,
    );
    expect(letter.subject).toBe("Acme replied to your message");
    expect(letter.text).toContain("> You:\n> Where is my order?\n\nIt ships **today**.");
    expect(letter.text).toContain("Sent an image.");
    expect(letter.text).toContain(`Read the conversation and answer here: ${links.chatUrl}`);
    expect(letter.html).toContain("<strong>today</strong>");
    expect(letter.html).not.toContain("**today**");
  });
});

describe("the transcript", () => {
  const at = new Date("2026-11-11T20:20:00Z");
  const line = {
    body: "Hello",
    kind: "text" as const,
    authorVisitorId: null,
    authorOperatorId: null,
    authorApiKeyId: null,
    replyTo: null,
    createdAt: at,
  };

  test("names each author as the visitor knows them, with the time in UTC", () => {
    const authors = new Map([
      ["op", { name: "Anna Smith", pictureUpdatedAt: null, isDeleted: false }],
      ["key", { name: "Help bot", pictureUpdatedAt: null, isDeleted: false }],
    ]);
    const letter = transcriptLetter(
      "Acme",
      [
        { ...line, authorVisitorId: "v", body: "Hi" },
        { ...line, authorOperatorId: "op", body: "Use **Export**." },
        { ...line, authorApiKeyId: "key", kind: "image", body: null },
      ],
      authors,
      { ...links, logoUrl: null },
    );
    expect(letter.subject).toBe("Your conversation with Acme");
    expect(letter.text).toContain("You, 2026-11-11 20:20 UTC:\nHi");
    expect(letter.text).toContain("Anna, 2026-11-11 20:20 UTC:\nUse **Export**.");
    expect(letter.text).toContain("Help bot, 2026-11-11 20:20 UTC:\nSent an image.");
    expect(letter.html).toContain("<strong>Export</strong>");
    expect(letter.html).not.toContain("<img");
  });
});
