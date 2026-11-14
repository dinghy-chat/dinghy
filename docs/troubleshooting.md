# Troubleshooting

Run the `docker compose` commands here from the folder with `compose.yaml`. If you installed with `sudo` and your user is not in the `docker` group, put `sudo` before each one.

## First checks

```sh
docker compose ps
docker compose logs --tail 50 app
curl https://chat.example.com/readyz
```

`/readyz` answers 200 when the app can reach its database. Its body also names Valkey (`"valkey":"failed"` when it is down, while chat keeps working) and the worker (`"worker":"stale"` when no worker finished a pass in 5 minutes, so alerts, file deletions and purges wait). To restart everything, run `docker compose up -d --wait`.

## The install

**"has no DNS record yet" or "is not an address on this server".** Add an A record for your domain that points at the server's public address, wait for it to spread, and run the installer again. Turn off any proxy on that record, such as Cloudflare's orange cloud, until the first certificate works.

**"Another program uses port 80" or "443".** Stop that program. To keep your own proxy, install by hand and read [Behind your own reverse proxy](self-hosting.md#behind-your-own-reverse-proxy).

**The install ends with "does not answer yet".** Check these in order:

1. Your cloud provider's firewall allows ports 80 and 443.
2. The domain points at this server.
3. `docker compose logs caddy` has no certificate error. Let's Encrypt limits repeated failures, so fix the cause before you try many times.

**I typed a wrong answer.** Run the installer again if the setup failed. To change the domain later, edit `CHAT_DOMAIN` in `.env`, and also set `COMPOSE_PROFILES=tls` if you started with no domain. Run `docker compose up -d --wait`, and update the tag on your site.

## The chat widget

**The button does not appear on my site.** Open the browser's developer tools, and read the console and the network tab.

- If `loader.js` fails, the address in the tag is wrong, or your site's Content Security Policy blocks it. See [the policy to use](add-to-your-site.md#if-your-site-has-a-content-security-policy).
- Check that the tag has `data-key`, and that it does not have `data-launcher="hidden"`.

**The chat opens, but each message says "Not sent. Select to try again".** Your site is probably not on the allowed list. The browser's console then shows a CORS error for the request. Add your site's exact origin under **Allowed sites** in **Settings > Install**. `https://example.com` and `https://www.example.com` are two different origins.

**The chat says "Connection lost. Trying again..." and replies never appear.** Check that the page is not served from the same address as Dinghy. The chat must be on another origin.

**A signed-in user sees "Not sent. Select to try again".** Check the token fields in [the table](add-to-your-site.md#show-who-is-chatting). The usual causes are a wrong `aud`, `iat` and `exp` more than 24 hours apart, or a secret that was replaced in **Settings > Install**.

**A visitor's image or file fails.** An image must be PNG, JPEG or WebP, under 5 MB and under 16 megapixels. A file must be one of [the allowed types](add-to-your-site.md#what-visitors-can-do), up to 10 MB, and visitors can send files only while **Visitors can send files** is on in **Settings > Appearance**. Under heavy load, the server also refuses uploads for a short time. [The measurements](measurements.md) have the numbers.

## Alerts

**No push notification.** In **Settings > Notifications**, select **Send a test**. Browser notifications are set per browser, so turn them on in each browser you use.

- "Browser notifications are not set up on this server" means `docker compose restart app` has not run since the setup.
- "Notification permission is not enabled" means you must allow notifications for this site in the browser's settings. Dismissing the browser's question has the same effect.
- "Dinghy could not turn on notifications" often means a private window. Use a normal one.
- On an iPhone, open the app from the Home Screen. See [Get alerts](operator-guide.md#get-alerts).

**No email.** Email notifications are set per workspace, in **Settings > Notifications**. Check that they are on in this workspace. Then set `SMTP_URL` and `MAIL_FROM` in `.env`, and run `docker compose up -d --wait`. Then read `docker compose logs app` for a mail error.

## Sign-in

**No sign-in link arrives.** Check the spam folder, then `docker compose logs app` for a mail error. Without a mail server, or for a link at once, run `docker compose exec app chat sign-in-link you@example.com`. It prints a link that works once, for 15 minutes.

**"That link has expired or was already used".** Ask for a new one. A link works once, for 15 minutes, and only the button on the page it opens uses it. A mail scanner that opens the link first does no harm. If you asked for several links, each one still works until it expires or you use it.

**"Too many email links requested".** Wait an hour, or run `chat sign-in-link` as above.

**All visitors share one rate limit, or the limits look wrong.** Set `TRUSTED_PROXY_HOPS` as [Behind your own reverse proxy](self-hosting.md#behind-your-own-reverse-proxy) explains.

## Backups and upgrades

**"Something is still connected to the database".** Stop the app first with `docker compose stop app`. If the nightly backup is running, wait for it.

**"This command cannot read" a backup file.** Run `sudo chown 1000 <file>`.

**Postgres stays down after an upgrade, with a message about old data.** The release moved to a new Postgres major version. Run `scripts/upgrade-postgres.sh`.

**"This database comes from a newer release".** Your image is older than your data. Use that release or a later one. To go back to an older release on purpose, read [Going back](self-hosting.md#going-back).

**"Not enough free disk space for a backup".** Read [The disk is full](runbooks.md#the-disk-is-full).

## Get help

Email `hello@dinghy.chat` with the output of `docker compose ps` and the last lines of `docker compose logs app`. Check that it holds no password first.
