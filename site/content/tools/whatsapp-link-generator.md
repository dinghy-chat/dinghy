---
title: WhatsApp link generator: wa.me links with a message
nav: WhatsApp link generator
description: Free WhatsApp link generator. Enter your country code, number and a prefilled message, and get a working wa.me click to chat link plus the HTML for your site.
date: 2026-11-27
updated: 2026-11-27
order: 7
card: A wa.me link that opens a chat with your number and a message ready
image: whatsapp-link-generator
---

# WhatsApp link generator

A WhatsApp link opens a chat with your number, with a message already typed in, so someone can message you without saving your number first. Enter your number below and you get a `wa.me` link in the format [WhatsApp's click to chat page](https://faq.whatsapp.com/5913398998672934) gives, with the spaces, dashes and leading zeros taken out.

<div class="tool">
<div class="tool-pane" data-tool="whatsapp">
<div class="tool-inputs">
<p class="tool-kicker">Your number</p>
<div class="tool-pair is-phone"><div class="tool-field"><label class="tool-label" for="wa-country"><b>Country code</b></label><div class="tool-input is-text"><span class="tool-unit is-before" aria-hidden="true">+</span><input id="wa-country" type="text" name="country" value="44" maxlength="6" inputmode="numeric" autocomplete="off"></div></div><div class="tool-field"><label class="tool-label" for="wa-phone"><b>Phone number</b></label><div class="tool-input is-text"><input id="wa-phone" type="text" name="phone" value="07700 900123" maxlength="30" inputmode="tel" autocomplete="off"></div></div></div>
<div class="tool-field"><label class="tool-label" for="wa-message"><b>Message</b><span>Optional, typed in for the visitor</span></label><div class="tool-input"><textarea id="wa-message" name="message" rows="4" maxlength="1000">Hi! I have a question about my order.</textarea></div></div>
<p class="tool-formula"><span class="tool-kicker">The rules</span><span class="tool-sum">Country code, then the number without its leading 0. Digits only, no + and no spaces.</span></p>
</div>
<div class="tool-result">
<div class="tool-live" aria-live="polite">
<p class="tool-kicker">Your WhatsApp link</p>
<p class="tool-code is-hero" data-out="link">https://wa.me/447700900123?text=Hi!%20I%20have%20a%20question%20about%20my%20order.</p>
<p class="tool-verdict" data-verdict data-tone="good">Opens a chat with +447700900123.</p>
<p class="tool-error" data-error hidden>Check the number. With its country code, a full number has 7 to 15 digits.</p>
</div>
<div class="tool-live">
<p class="tool-kicker">HTML to paste</p>
<p class="tool-code" data-out="html">&lt;a href="https://wa.me/447700900123?text=Hi!%20I%20have%20a%20question%20about%20my%20order."&gt;Chat on WhatsApp&lt;/a&gt;</p>
</div>
<dl class="tool-stats">
<div><dt>Digits in the number</dt><dd data-out="digits">12</dd></div>
<div><dt>Message characters</dt><dd data-out="length">37</dd></div>
</dl>
<div class="tool-actions"><button type="button" class="tool-button" data-copies="link">Copy link</button><button type="button" class="tool-button is-quiet" data-copies="html">Copy HTML</button><a class="tool-button is-quiet" data-href="link" href="https://wa.me/447700900123?text=Hi!%20I%20have%20a%20question%20about%20my%20order." target="_blank" rel="noopener">Test it</a><span class="visually-hidden" role="status" data-status></span></div>
</div>
</div>
</div>

## How a WhatsApp link works

WhatsApp calls this click to chat. The link is `https://wa.me/` followed by your full number in international format. To type a message in for the visitor, add `?text=` and the message, URL-encoded.

```text
https://wa.me/447700900123?text=Hi!%20I%20have%20a%20question
```

A click opens WhatsApp on a phone, or WhatsApp Web on a computer, with a chat to that number. The message sits in the text box, and nothing gets sent until the visitor taps send. [WhatsApp's page](https://faq.whatsapp.com/5913398998672934) says the number needs an active WhatsApp account, and it doesn't have to be in the visitor's contacts.

![A smartphone with a green chat bubble on its screen stands on a small island like a lighthouse, near a small sailboat](/img/illustrations/whatsapp-link-generator.webp)

## The number format

WhatsApp wants the full number in international format, with no zeros in front, no brackets and no dashes. That's the country code, then the number as people dial it inside the country, minus the leading 0.

| Number as you write it | Country code | In the link |
|---|---|---|
| 07700 900123 | 44, UK | `447700900123` |
| 06 12 34 56 78 | 33, France | `33612345678` |
| 0151 23456789 | 49, Germany | `4915123456789` |
| (415) 555-0100 | 1, US and Canada | `14155550100` |
| +44 (0) 7700 900123 | Already in the number | `447700900123` |

If you type the number with a `+` or `00` in front, the generator takes the country code from it and ignores the country code field.

## Common mistakes

- Keeping the leading 0. `wa.me/07700900123` points to a number that doesn't exist.
- Keeping the plus or the 00. WhatsApp's own example of what not to use is `https://wa.me/+001-(XXX)XXXXXXX`.
- The (0) in UK style numbers. "+44 (0) 7700 900123" has a 0 you only dial inside the UK.
- The country code twice. With 44 in the country code field, the number field shouldn't start with 44 too. The generator warns you when it does.
- A number with no WhatsApp account. Click to chat needs an active account on the other end, so a landline without WhatsApp won't work.
- Spaces in the message as they are. The message has to be URL-encoded, so a space becomes `%20` and a question mark becomes `%3F`. The generator does this.

WhatsApp also offers official "Chat on WhatsApp" button images on the same [click to chat page](https://faq.whatsapp.com/5913398998672934), in green and white. Its page asks you to use them as they are.

## WhatsApp or a chat on your website

Dinghy has no WhatsApp channel, so this isn't a pitch. The two do different jobs.

A WhatsApp link suits people who'd rather talk on their phone. They get your replies with their other messages, and they can come back to the chat days later. It suits shops where customers send photos, local businesses and anyone whose customers already live in WhatsApp. You answer from your phone too, and it's your personal or business number on the other end.

A chat box on your website suits visitors who are already on your site, reading your pricing or stuck at checkout. They don't have to switch apps, sign in or share a phone number. If that's the gap you want to close, Dinghy is a [chat widget for your site](/) with a shared inbox for your team. You can have both.

## FAQ

### Do I need WhatsApp Business for a wa.me link?

No. [WhatsApp's page](https://faq.whatsapp.com/5913398998672934) only asks for a number with an active WhatsApp account. The link works the same for a personal number.

### Can I make a link without a phone number?

Yes. Leave the number empty and keep a message. The link becomes `https://wa.me/?text=...`, and WhatsApp shows the visitor a list of contacts to send the message to. People use it for "share this with a friend" buttons.

### Does a wa.me link work on a computer?

Yes. WhatsApp says click to chat works on the phone and on WhatsApp Web. On a computer, the link opens a WhatsApp page that hands over to the desktop app or WhatsApp Web.

### Can the message have emojis and line breaks?

Yes. The generator URL-encodes them with the rest of the message. Press Test it to see how the message looks in WhatsApp before you put the link on your site.

### Why does my link say the number isn't on WhatsApp?

Most of the time the number in the link is wrong. Look for a leading 0 after the country code, a missing country code, or the country code twice. If the number is right, it may not have a WhatsApp account.
