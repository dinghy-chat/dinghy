import { describe, expect, test } from "vitest";
import { replyLetter } from "./alerts.ts";
import { transcriptLetter } from "./transcripts.ts";
import { visitorWords } from "./visitor-words.ts";

const links = { chatUrl: "https://chat.example.com/chat/t", stopUrl: "https://chat.example.com/s" };
const acme = { name: "Acme", logoUrl: null };
const english = visitorWords("en");
const french = visitorWords("fr");

// The words a reader sees, without the tags and their attributes.
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ");

describe("the reply email", () => {
  const quote = {
    id: "q1",
    authorName: null,
    fromVisitor: true,
    text: "Where is my order?",
    hasImage: false,
  };
  const letter = replyLetter(
    acme,
    [
      { author: "Anna", body: "It ships **today**.", kind: "text", filename: null, quote },
      { author: "Acme", body: null, kind: "image", filename: null, quote: null },
      { author: "Acme", body: "Anything else?", kind: "text", filename: null, quote: null },
    ],
    links,
    english,
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
      [{ author: "Anna", body: "Hi", kind: "text", filename: null, quote: null }],
      links,
      english,
    );
    expect(withLogo.html).toContain('<img src="https://chat.example.com/logo.webp?v=1&amp;x=2"');
  });

  test("escapes what people wrote, the workspace's name included", () => {
    const written = replyLetter(
      { name: "<b>Shop</b>", logoUrl: null },
      [
        {
          author: "<i>Eve</i>",
          body: "<script>x</script>",
          kind: "text",
          filename: null,
          quote: null,
        },
      ],
      links,
      english,
    );
    expect(written.html).not.toMatch(/<(b|i|script)>/);
    expect(written.html).toContain("&lt;i&gt;Eve&lt;/i&gt; replied");
    expect(written.html).toContain("&lt;b&gt;Shop&lt;/b&gt;");
  });
});

test("a reply email shows a file by its name, linked to the chat", () => {
  const letter = replyLetter(
    acme,
    [
      { author: "Anna", body: null, kind: "file", filename: "invoice (May).pdf", quote: null },
      { author: "Anna", body: null, kind: "file", filename: null, quote: null },
    ],
    links,
    english,
  );
  expect(letter.text).toContain("Sent the file invoice (May).pdf.");
  expect(letter.html).toContain(`<a href="${links.chatUrl}">Sent the file invoice (May).pdf.</a>`);
  // A removed file has no name left, and is still not an image.
  expect(letter.text).toContain("Sent a file.");
  expect(letter.text).not.toContain("image");
});

describe("the transcript", () => {
  const at = new Date("2026-11-11T20:20:00Z");
  const line = {
    body: "Hello",
    filename: null,
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
      english,
    );
    expect(letter.subject).toBe("Your conversation with Acme");
    const when = english.time(at);
    expect(when).toMatch(/^Nov 11, 2026, 8:20\sPM UTC$/);
    expect(letter.text).toContain(`You, ${when}:\nHi`);
    expect(letter.text).toContain(`Anna, ${when}:\nUse **Export**.`);
    // A bot's key has a name for the team. The visitor reads the workspace.
    expect(letter.text).toContain(`Acme, ${when}:\nSent an image.`);
    expect(letter.text).toContain(`Continue the chat: ${links.chatUrl}`);
    expect(letter.html).toContain("<strong>Export</strong>");
    expect(letter.html).not.toContain("<img");
  });

  test("shows a file by its name, linked to the chat", () => {
    const letter = transcriptLetter(
      acme,
      [{ ...line, authorVisitorId: "v", kind: "file", body: null, filename: "notes.txt" }],
      new Map(),
      links,
      english,
    );
    const said = "Sent the file notes.txt. Open the chat to download it.";
    expect(letter.text).toContain(`You, ${english.time(at)}:\n${said}`);
    expect(letter.html).toContain(`<a href="${links.chatUrl}">${said}</a>`);
  });

  test("shares the reply email's header and footer", () => {
    const letter = transcriptLetter(acme, [line], new Map(), links, english);
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
      english,
    );
    expect(letter.text).not.toContain("A visitor");
    expect(letter.text).toContain(`The Acme team, ${english.time(at)}:\nHello`);
    expect(letter.html).toContain('<img src="https://chat.example.com/logo.png"');
  });
});

describe("in the visitor's language", () => {
  test("the reply email is in French, from its subject to its stop link", () => {
    const quote = {
      id: "q1",
      authorName: null,
      fromVisitor: true,
      text: "Où est ma commande ?",
      hasImage: false,
    };
    const letter = replyLetter(
      acme,
      [
        { author: "Anna", body: "Elle part aujourd'hui.", kind: "text", filename: null, quote },
        { author: "Acme", body: null, kind: "image", filename: null, quote: null },
        { author: "Acme", body: null, kind: "file", filename: "facture.pdf", quote: null },
        { author: "Acme", body: null, kind: "file", filename: null, quote: null },
      ],
      links,
      french,
    );
    expect(letter.subject).toBe("Acme a répondu à votre message");
    expect(letter.text).toMatch(/^Bonjour,\n\nAcme a répondu à votre message\u00a0:/);
    expect(letter.text).toContain("> Vous\u00a0:\n> Où est ma commande ?");
    expect(letter.text).toContain("A envoyé une image.");
    expect(letter.text).toContain("A envoyé le fichier facture.pdf.");
    expect(letter.text).toContain("A envoyé un fichier.");
    expect(letter.html).toContain(
      `<a href="${links.chatUrl}">A envoyé le fichier facture.pdf.</a>`,
    );
    expect(letter.text).toContain(`Lisez la conversation et répondez ici\u00a0: ${links.chatUrl}`);
    expect(letter.text).toMatch(/À bientôt,\nL'équipe Acme$/);
    expect(letter.html).toContain(">Anna a répondu</p>");
    expect(letter.html).toContain(">Répondre dans le chat</a>");
    expect(letter.html).toContain(">Ne plus recevoir ces e-mails</a>");
    expect(letter.html).not.toContain("replied");
  });

  test("the transcript is in French, with French dates", () => {
    const at = new Date("2026-11-11T20:20:00Z");
    const letter = transcriptLetter(
      acme,
      [
        {
          body: "Bonjour",
          filename: null,
          kind: "text",
          authorVisitorId: "v",
          authorOperatorId: null,
          authorApiKeyId: null,
          replyTo: null,
          createdAt: at,
        },
        {
          body: null,
          filename: "notes.txt",
          kind: "file",
          authorVisitorId: null,
          authorOperatorId: null,
          authorApiKeyId: null,
          replyTo: null,
          createdAt: at,
        },
      ],
      new Map(),
      links,
      french,
    );
    expect(letter.subject).toBe("Votre conversation avec Acme");
    expect(french.time(at)).toBe("11 nov. 2026, 20:20 UTC");
    expect(letter.text).toContain("Vous, 11 nov. 2026, 20:20 UTC\u00a0:\nBonjour");
    expect(letter.text).toContain(`Continuer la conversation\u00a0: ${links.chatUrl}`);
    expect(letter.html).toContain(">Continuer la conversation</a>");
    const said = "Fichier notes.txt envoyé. Ouvrez le chat pour le télécharger.";
    expect(letter.text).toContain(`L'équipe Acme, 11 nov. 2026, 20:20 UTC\u00a0:\n${said}`);
    expect(letter.html).toContain(`<a href="${links.chatUrl}">${said}</a>`);
  });

  test("a file in Spanish", () => {
    const spanish = visitorWords("es");
    const letter = replyLetter(
      acme,
      [{ author: "Ana", body: null, kind: "file", filename: "factura.pdf", quote: null }],
      links,
      spanish,
    );
    expect(letter.text).toContain("Envió el archivo factura.pdf.");
  });
});
