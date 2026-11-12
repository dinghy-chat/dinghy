import { describe, expect, test } from "vitest";
import { replyLetter } from "./alerts.ts";
import { transcriptLetter } from "./transcripts.ts";

const links = { chatUrl: "https://chat.example.com/chat/t", stopUrl: "https://chat.example.com/s" };
const acme = { name: "Acme", logoUrl: null };

// The words a reader sees, without the tags and their attributes.
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ");

describe("the reply email", () => {
  const quote = {
    id: "q1",
    authorName: null,
    fromVisitor: true,
    excerpt: "Where is my order?",
    hasImage: false,
  };
  const letter = replyLetter(
    acme,
    [
      { author: "Anna", body: "It ships **today**.", quote },
      { author: "Acme", body: null, quote: null },
      { author: "Acme", body: "Anything else?", quote: null },
    ],
    links,
  );

  test("shows each reply under its quote, Markdown as typed in text and formatted in HTML", () => {
    expect(letter.subject).toBe("Acme replied to your message");
    expect(letter.text).toContain("> You:\n> Where is my order?\n\nIt ships **today**.");
    expect(letter.text).toContain("Sent an image.");
    expect(letter.text).toContain(`Read the conversation and answer here: ${links.chatUrl}`);
    expect(letter.html).toContain("<strong>today</strong>");
    expect(letter.html).not.toContain("**today**");
  });

  test("the HTML names each replier above a bubble, with the quote inside it", () => {
    expect(letter.html).toContain(">Anna replied</p>");
    // Two replies in a row by one author share one line, as a chat groups them.
    expect(letter.html.match(/>Acme replied<\/p>/g)).toHaveLength(1);
    expect(letter.html).toMatch(
      /border-radius:4px 18px 18px 18px[^>]*><div[^>]*><strong>You<\/strong><br>Where is my order\?<\/div>/,
    );
    expect(letter.html).not.toContain("Hi,");
    expect(letter.html).not.toContain("Cheers");
    expect(letter.html).not.toContain("replied to your message");
  });

  test("the HTML links the chat and the stop page behind words, never as a raw address", () => {
    expect(letter.html).toContain(`href="${links.chatUrl}"`);
    expect(letter.html).toContain(">Reply in the chat</a>");
    expect(letter.html).toContain(`href="${links.stopUrl}"`);
    expect(letter.html).toContain(">Stop these emails</a>");
    expect(letter.html).toContain(
      "You got this because this address was entered in a chat with Acme.",
    );
    const shown = visibleText(letter.html);
    expect(shown).not.toContain(links.chatUrl);
    expect(shown).not.toContain(links.stopUrl);
  });

  test("the header shows the logo, or the name's first letter without one", () => {
    expect(letter.html).toMatch(/>A<\/div><\/td><td[^>]*>Acme<\/td>/);
    expect(letter.html).not.toContain("<img");
    const withLogo = replyLetter(
      { name: "Acme", logoUrl: "https://chat.example.com/logo.webp?v=1&x=2" },
      [{ author: "Anna", body: "Hi", quote: null }],
      links,
    );
    expect(withLogo.html).toContain('<img src="https://chat.example.com/logo.webp?v=1&amp;x=2"');
  });

  test("escapes what people wrote, the workspace's name included", () => {
    const written = replyLetter(
      { name: "<b>Shop</b>", logoUrl: null },
      [{ author: "<i>Eve</i>", body: "<script>x</script>", quote: null }],
      links,
    );
    expect(written.html).not.toMatch(/<(b|i|script)>/);
    expect(written.html).toContain("&lt;i&gt;Eve&lt;/i&gt; replied");
    expect(written.html).toContain("&lt;b&gt;Shop&lt;/b&gt;");
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
      acme,
      [
        { ...line, authorVisitorId: "v", body: "Hi" },
        { ...line, authorOperatorId: "op", body: "Use **Export**." },
        { ...line, authorApiKeyId: "key", kind: "image", body: null },
      ],
      authors,
      links,
    );
    expect(letter.subject).toBe("Your conversation with Acme");
    expect(letter.text).toContain("You, 2026-11-11 20:20 UTC:\nHi");
    expect(letter.text).toContain("Anna, 2026-11-11 20:20 UTC:\nUse **Export**.");
    // A bot's key has a name for the team. The visitor reads the workspace.
    expect(letter.text).toContain("Acme, 2026-11-11 20:20 UTC:\nSent an image.");
    expect(letter.text).toContain(`Continue the chat: ${links.chatUrl}`);
    expect(letter.html).toContain("<strong>Export</strong>");
    expect(letter.html).not.toContain("<img");
  });

  test("shares the reply email's header and footer", () => {
    const letter = transcriptLetter(acme, [line], new Map(), links);
    expect(letter.html).toContain(">Continue the chat</a>");
    expect(letter.html).toContain(">Stop these emails</a>");
    const shown = visibleText(letter.html);
    expect(shown).not.toContain(links.chatUrl);
    expect(shown).not.toContain(links.stopUrl);
  });

  test("a team reply whose author is gone is the team's, never a visitor's", () => {
    const letter = transcriptLetter(
      { name: "Acme", logoUrl: "https://chat.example.com/logo.png" },
      [{ ...line, authorOperatorId: "gone" }],
      new Map(),
      links,
    );
    expect(letter.text).not.toContain("A visitor");
    expect(letter.text).toContain("The Acme team, 2026-11-11 20:20 UTC:\nHello");
    expect(letter.html).toContain('<img src="https://chat.example.com/logo.png"');
  });
});
