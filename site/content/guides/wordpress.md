---
title: How to add live chat to a WordPress site | Dinghy
nav: WordPress
description: Add the Dinghy live chat to WordPress with a header and footer plugin or a few lines in your child theme. You don't need a chat plugin.
date: 2026-11-08
updated: 2026-11-14
order: 1
card: With a header and footer plugin, or your child theme
logo: wordpress
---

# Add live chat to WordPress

You don't need a chat plugin. Dinghy is one script tag, and WordPress just has to print it at the bottom of every page.

## Get your tag

It's in the Dinghy operator app, under Settings > Install.

```html
<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>
```

Then add your site under Allowed sites in Settings > Install, like `https://www.example.com`. If people also visit without `www`, add that too.

## Use a header and footer plugin

If you already have a plugin that adds code to your header and footer, like WPCode, use it. If not, install one from Plugins > Add New.

1. Open the plugin's header and footer settings.
2. Paste the Dinghy tag in the footer box, the one that prints before `</body>`.
3. Save.

Open your site in a private window. The chat button should be in the corner.

## Use your child theme

If you have a child theme, add this at the end of its `functions.php`. It prints the tag in the footer of every page:

```php
add_action('wp_footer', function () {
  echo '<script src="https://chat.example.com/widget/loader.js" data-key="wk_your_public_key" async></script>';
});
```

Use a child theme, not your main theme. A theme update replaces the main theme's files and your change is gone.

## WordPress.com

On WordPress.com, adding plugins or custom code needs a plan that allows plugins. If yours doesn't, you can't add the chat. Self-hosted WordPress, the one from wordpress.org, doesn't have that limit.

## Check that it works

1. Open your site in a private window.
2. Click the chat button and send a test message.
3. It should show up in the Dinghy inbox within a second or two.

No button? A caching plugin may be serving the old page, so clear its cache. Still missing? Open the browser's developer console. If `loader.js` failed, the address in the tag is wrong or a Content Security Policy blocks it. If the button shows but every message says "Not sent", add the exact address you're on to Allowed sites, `www` included. [Troubleshooting](/docs/troubleshooting) has more.

## Next

- Change colors, the chat button and the words in Settings > Appearance. No code. The tag's `data-primary` and `data-accent` win over the setting. See [Add the chat to your site](/docs/add-to-your-site#change-how-it-looks).
- If your site has accounts, you can show which logged-in user is chatting. See [Show who is chatting](/docs/add-to-your-site#show-who-is-chatting).
