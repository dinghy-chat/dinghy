---
title: How to add live chat to a WordPress site | Dinghy
nav: WordPress
description: Add the Dinghy live chat to WordPress with a header and footer plugin or a few lines in your child theme. No chat plugin needed.
date: 2026-11-08
updated: 2026-11-14
order: 1
card: With a header and footer plugin, or your child theme
logo: wordpress
---

# Add live chat to WordPress

You don't need a special chat plugin. The Dinghy chat is one script tag, and WordPress just needs to print it at the bottom of every page. Here are two ways to do that.

## Get your tag

Copy it from the Dinghy operator app, under Settings > Install. It looks like this:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Then add your site under Allowed sites in Settings > Install, for example `https://www.example.com`. If people also visit without `www`, add that too.

## Use a header and footer plugin

If you already use a plugin that adds code to your header and footer, like WPCode, use that. If not, install one from Plugins > Add New.

1. Open the plugin's header and footer settings.
2. Paste the Dinghy tag in the footer box, the one that prints before `</body>`.
3. Save.

Open your site in a private window, and the chat button should be in the corner.

## Use your child theme

If you have a child theme, add this at the end of its `functions.php`. It prints the tag in the footer of every page:

```php
add_action('wp_footer', function () {
  echo '<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>';
});
```

Use a child theme, not your main theme. A theme update replaces the main theme's files and would remove your change.

## WordPress.com

On WordPress.com, adding plugins or custom code needs a plan that allows plugins. If yours doesn't, the chat can't go in. Self-hosted WordPress, the kind from wordpress.org, has no such limit.

## Check that it works

1. Open your site in a private window.
2. Click the chat button and send a test message.
3. It should show up in the Dinghy inbox within a second or two.

If the button doesn't appear, a caching plugin may be serving the old page, so clear its cache. If it's still missing, open the browser's developer console. A failed `loader.js` means the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but each message says "Not sent", add the exact address you're visiting to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting) has more.

## Next

- Match the chat to your theme in Settings > Appearance: colors, the chat button, the words and more, with no code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- Show which logged-in user is chatting, if your site has accounts. See [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).
