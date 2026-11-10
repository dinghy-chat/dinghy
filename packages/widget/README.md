# Dinghy widget

The chat widget for [Dinghy](https://dinghy.chat), a small live support chat you can host yourself. MIT licensed.

## Add it with a tag

```html
<script src="https://chat.example.com/widget/loader.js" data-key="YOUR_PUBLIC_KEY" async></script>
```

## Or add it from npm

```sh
npm install @dinghy-chat/widget
```

```ts
import { init } from "@dinghy-chat/widget";

const dinghy = init({ url: "https://chat.example.com", key: "YOUR_PUBLIC_KEY" });
dinghy.on("unread", (count) => console.log(count));
```

`init` adds the tag once and returns the typed `Dinghy` object. Calls made before the script loads wait for it. It takes `url`, `key`, and `primary`, `accent`, `mascot`, `launcher`, `position`, `offsetX`, `offsetY` and `zIndex`.

## Attributes

| Attribute                | Effect                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `data-primary="#0b2239"` | Sets the header, your visitor's messages and the boat's hull. Use six hex digits.           |
| `data-accent="#e5352b"`  | Sets the sail and the send button, and the launcher if the boat is off. Use six hex digits. |
| `data-mascot="false"`    | Removes the boat. Every state keeps its text.                                               |
| `data-launcher="hidden"` | Hides the launcher, so your own button opens the chat.                                      |
| `data-position="left"`   | Puts the launcher and the chat on the left. The default is `right`.                         |
| `data-offset-x="24"`     | Pixels from the side of the window. The default is `16`.                                    |
| `data-offset-y="80"`     | Pixels from the bottom of the window. The default is `16`.                                  |

The widget ignores a value in any other format. The boat stops moving for a visitor who asks for reduced motion.

Set `--dinghy-font`, `--dinghy-radius` and `--dinghy-launcher-radius` on the `dinghy-chat` element to match your fonts and corners.

## Host page API

| Call                                | What it does                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Dinghy.open({ message })`          | Opens the chat. `message` is optional and fills the message box without sending it                              |
| `Dinghy.close()`, `Dinghy.toggle()` | Closes the chat, or opens it if it is closed                                                                    |
| `Dinghy.show()`, `Dinghy.hide()`    | Shows or hides the launcher                                                                                     |
| `Dinghy.identify(token)`            | Signs in a user. `token` is a string, or a function that returns a promise of one, so a tab can renew a token   |
| `Dinghy.reset()`                    | Ends the session in all tabs. Call this at sign-out                                                             |
| `Dinghy.setContext(data)`           | Unsigned facts for operators, such as a plan. Up to 20 keys, each a short string, a number, a boolean or `null` |
| `Dinghy.configure(options)`         | Changes `primary`, `accent`, `position`, `offsetX`, `offsetY` and `zIndex` now                                  |
| `Dinghy.on(event, callback)`        | Calls `callback` on each event, and returns a function that removes it                                          |
| `Dinghy.state`                      | `{ ready, open, unread }`                                                                                       |

The events are `ready`, `open`, `close`, `unread` (the count, at once and on each change), `message:sent` and `message:received` (`{ body }`) and `conversation:started`.

To call these before the loader finishes, queue them:

```html
<script>window.Dinghy = { q: [["identify", "TOKEN"], ["on", "unread", console.log]] };</script>
```

Your backend signs the token with HS256 and the workspace's signing secret. It needs `sub` (your user ID), `aud` (the public key), `iat`, and `exp` at most 24 hours later. `email`, `name` (one line, up to 100 characters) and `attributes` (an object up to 2 KB) are optional, and operators read them.

The widget stores nothing in the browser until the visitor sends a message, and then only its own token in `localStorage`. While such a visitor has the chat open, it notes that in `sessionStorage`, so the chat opens again after a reload in the same tab. Once the visitor has chatted, it reports the page's address, without its query string or `#` part, its title and the `setContext` data, so operators see where the visitor is.

## Content Security Policy

If your site sets a CSP, add the origin of your Dinghy server to these directives:

```
script-src https://chat.example.com;
connect-src https://chat.example.com;
img-src https://chat.example.com;
```

If your Dinghy serves images from a separate origin (`IMAGES_ORIGIN`), allow that origin in `img-src` too.

The widget needs no `style-src` change, because it uses constructable stylesheets and the CSSOM.

The full guide is at <https://dinghy.chat/docs/add-to-your-site>.
