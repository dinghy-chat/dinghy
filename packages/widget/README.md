# Dinghy widget

Add this to your site:

```html
<script src="https://chat.example.com/widget/loader.js" data-key="YOUR_PUBLIC_KEY" async></script>
```

Add `data-launcher="hidden"` to the script tag to use your own button.

Match your product's design with these attributes on the same script tag:

| Attribute                | Effect                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `data-primary="#0b2239"` | Sets the header, your visitor's messages and the boat's hull. Use six hex digits.           |
| `data-accent="#e5352b"`  | Sets the sail and the send button, and the launcher if the boat is off. Use six hex digits. |
| `data-mascot="false"`    | Removes the boat. Every state keeps its text.                                               |

The widget ignores a color in any other format. The boat stops moving for a visitor who asks for reduced motion.

## Host page API

| Call                              | What it does                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Dinghy.open()`, `Dinghy.close()` | Opens or closes the chat                                                                                                   |
| `Dinghy.identify(token)`          | Signs in a user. `token` is a string, or a function that returns a promise of one, so a tab can renew a token that expired |
| `Dinghy.reset()`                  | Ends the session in all tabs. Call this at sign-out                                                                        |
| `Dinghy.onUnreadChange(callback)` | Calls `callback(count)` now and on each change, and returns a function that removes it                                     |

To call these before the loader finishes, queue them:

```html
<script>window.Dinghy = { q: [["identify", "TOKEN"]] };</script>
```

Your backend signs the token with HS256 and the workspace's signing secret. It needs `sub` (your user ID), `aud` (the public key), `iat`, and `exp` at most 24 hours later. `email`, `name` (one line, up to 100 characters) and `attributes` (an object up to 2 KB) are optional, and operators read them.

The widget stores nothing in the browser until the visitor sends a message, and then only its own token in `localStorage`. Once the visitor has chatted, it reports the page's address, without its query string or `#` part, and its title, so operators see the pages the visitor went through.

## Content Security Policy

If your site sets a CSP, add the origin of your Dinghy server to these directives:

```
script-src https://chat.example.com;
connect-src https://chat.example.com;
img-src https://chat.example.com;
```

If your Dinghy serves images from a separate origin (`IMAGES_ORIGIN`), allow that origin in `img-src` too.

The widget needs no `style-src` change, because it uses constructable stylesheets and the CSSOM.
