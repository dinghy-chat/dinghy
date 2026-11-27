---
title: Mailto link generator: email links with subject and body
nav: Mailto link generator
description: Free mailto link generator. Add to, cc, bcc, a subject and a body, and get a correctly encoded mailto link plus the HTML to paste into your site.
date: 2026-11-27
updated: 2026-11-27
order: 6
card: An email link with the subject and body filled in, encoded right
image: mailto-link-generator
---

# Mailto link generator

A mailto link opens a new email in the visitor's mail app, with the address, subject and body already filled in. Type yours below. The link and the HTML update as you type, with spaces, line breaks and symbols encoded the way mail apps expect.

<div class="tool">
<div class="tool-pane" data-tool="mailto">
<div class="tool-inputs">
<p class="tool-kicker">Your email</p>
<div class="tool-field"><label class="tool-label" for="mailto-to"><b>To</b><span>Separate addresses with commas</span></label><div class="tool-input is-text"><input id="mailto-to" type="text" name="to" value="hello@example.com" maxlength="500" inputmode="email" autocomplete="off" spellcheck="false"></div></div>
<div class="tool-pair"><div class="tool-field"><label class="tool-label" for="mailto-cc"><b>Cc</b></label><div class="tool-input is-text"><input id="mailto-cc" type="text" name="cc" value="" maxlength="500" inputmode="email" autocomplete="off" spellcheck="false"></div></div><div class="tool-field"><label class="tool-label" for="mailto-bcc"><b>Bcc</b></label><div class="tool-input is-text"><input id="mailto-bcc" type="text" name="bcc" value="" maxlength="500" inputmode="email" autocomplete="off" spellcheck="false"></div></div></div>
<div class="tool-field"><label class="tool-label" for="mailto-subject"><b>Subject</b></label><div class="tool-input is-text"><input id="mailto-subject" type="text" name="subject" value="Question about my order" maxlength="300" autocomplete="off"></div></div>
<div class="tool-field"><label class="tool-label" for="mailto-body"><b>Body</b><span>Line breaks are kept</span></label><div class="tool-input"><textarea id="mailto-body" name="body" rows="5" maxlength="1500">Hi there,&#10;&#10;My order number is #1042 &amp; I have a question.</textarea></div></div>
<p class="tool-formula"><span class="tool-kicker">The rules</span><span class="tool-sum">A space becomes %20, a line break becomes %0D%0A, and commas separate addresses.</span></p>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">Your mailto link</p>
<p class="tool-code is-hero" data-out="link">mailto:hello@example.com?subject=Question%20about%20my%20order&amp;body=Hi%20there%2C%0D%0A%0D%0AMy%20order%20number%20is%20%231042%20%26%20I%20have%20a%20question.</p>
<p class="tool-verdict" data-verdict data-tone="good">Ready. A click opens a new email in the visitor's mail app.</p>
<p class="tool-error" data-error hidden>One address doesn't look right. Each needs an @ and a domain, like hello@example.com.</p>
</div>
<div class="tool-live">
<p class="tool-kicker">HTML to paste</p>
<p class="tool-code" data-out="html">&lt;a href="mailto:hello@example.com?subject=Question%20about%20my%20order&amp;amp;body=Hi%20there%2C%0D%0A%0D%0AMy%20order%20number%20is%20%231042%20%26%20I%20have%20a%20question."&gt;Email us&lt;/a&gt;</p>
</div>
<dl class="tool-stats">
<div><dt>Characters</dt><dd data-out="length">160</dd></div>
<div><dt>Recipients</dt><dd data-out="recipients">1</dd></div>
</dl>
<div class="tool-actions"><button type="button" class="tool-button" data-copies="link">Copy link</button><button type="button" class="tool-button is-quiet" data-copies="html">Copy HTML</button><a class="tool-button is-quiet" data-href="link" href="mailto:hello@example.com?subject=Question%20about%20my%20order&amp;body=Hi%20there%2C%0D%0A%0D%0AMy%20order%20number%20is%20%231042%20%26%20I%20have%20a%20question.">Test it</a><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
</div>

## How a mailto link works

A mailto link is an address that starts with `mailto:` instead of `https://`. Everything after the address is optional. A question mark starts the extras, and an ampersand separates them.

```text
mailto:hello@example.com?cc=sam@example.com&subject=Hello&body=Hi%20there
```

The parts are `to` right after `mailto:`, then `cc`, `bcc`, `subject` and `body`. [RFC 6068](https://www.rfc-editor.org/rfc/rfc6068) is the standard that defines them. Put the link in an `<a href="...">` tag and a click opens the visitor's mail app with a new draft. Nothing gets sent until they press send.

![An open envelope with a letter inside floats on the sea, tied to a buoy, near a small sailboat](/img/illustrations/mailto-link-generator.webp)

## The encoding rules

A link can't hold spaces, line breaks or some symbols as they are, so each one becomes a percent sign and a code. The generator does this for you. If you write a link by hand, here's what trips people up.

| You type | In the link | Why |
|---|---|---|
| A space | `%20` | [RFC 6068](https://www.rfc-editor.org/rfc/rfc6068#section-5) says spaces should be `%20`. A `+` can stay a plus sign in some mail apps. |
| A line break | `%0D%0A` | The RFC says a line break in the body must be `%0D%0A`, both codes. |
| `&` | `%26` | A raw `&` starts the next field and cuts your text short. |
| `#` | `%23` | A raw `#` ends the link. Everything after it is lost. |
| `?` | `%3F` | The RFC doesn't allow a raw `?` inside a field. |
| `+` in an address | `%2B` | Addresses like `sam+shop@example.com` keep the plus once it's encoded. |
| Two addresses | `a@example.com,b@example.com` | Commas separate addresses. Semicolons aren't in the standard. |

In the HTML, the `&` between fields becomes `&amp;`. Browsers forgive a raw `&` in most cases, but `&amp;` is the valid form, and the snippet above uses it.

## Common mistakes

- Spaces as `+`. That's how web forms encode a space, and some mail apps show the plus signs in the subject.
- A raw `&` or `#` in the subject. "Order #1042" with a raw `#` gives a subject that just says "Order".
- Line breaks in the subject. The RFC says a line break should only go in the body.
- Long bodies. Mail apps don't agree on how long a link can be, and some cut it. Keep the body to a line or two that the visitor finishes.
- Testing only on your own computer. If you use a desktop mail app, the link works for you. Your visitors may use Gmail in a browser, where nothing opens at all.

## When a contact form or live chat beats a mailto link

A mailto link needs a mail app that's set up on the visitor's device. On a laptop where someone uses Gmail or Outlook in the browser, a click can open a mail app they never set up, or do nothing. On a phone it usually works, since the phone has a mail app with an account.

The address also sits in your page's HTML, where spam bots collect it. You'll get more spam to that address over time.

A mailto link is fine for a footer, a press contact or a "send us your logs" button. When you want questions from visitors who are reading your pricing or checkout page, a contact form or a chat box asks less of them. They type where they already are, and you can answer while they're still on the page. Dinghy is a chat widget for that. If the visitor has left by the time you reply, the [reply reaches them by email](/docs/operator-guide#answer-a-chat), so you keep what's good about email.

## FAQ

### Can a mailto link add an attachment?

No. RFC 6068 has no field for attachments, so you can't count on any mail app to add one. Ask people to attach the file once the draft opens, or use a form with a file field.

### Why does my mailto link do nothing when I click it?

The browser hands the link to the default mail app. If there isn't one, nothing happens, or the computer asks which app to use. In Chrome you can set Gmail to open mailto links in the site settings. Your visitors won't do that, so offer the address as text too.

### Can I set the sender or the "from" address?

No. The visitor's mail app sends from their own account. A mailto link can only fill in to, cc, bcc, subject and body.

### Do I need to encode the @ in the address?

No. The `@` stays as it is in the address. In the subject or the body, the generator encodes it as `%40`, which mail apps read back as `@`.
