# Check web push on a real phone

Automated tests cannot show a notification on a phone. Do this check on a real iPhone and a real Android phone before each release, and after a change to `apps/operator/public/sw.js`.

A phone needs HTTPS for push, so use a temporary tunnel to a development server.

1. Run `node apps/server/src/cli.ts push-keys`, and export the two lines it prints: `export VAPID_PUBLIC_KEY=...` and `export VAPID_PRIVATE_KEY=...`.
2. Run `export VAPID_SUBJECT=mailto:you@example.com`, with a real contact address.
3. In another terminal, run `cloudflared tunnel --url http://localhost:3000`. It prints an `https://` address.
4. Run `PUBLIC_URL=<that address> bun run dev`. It starts the server and the worker with the keys from your environment.
5. Stop the tunnel when you finish. The address gives the whole internet a path to the development server.

On each phone:

1. On an iPhone, open the address in Safari, select Share, then Add to Home Screen. Open the app from the Home Screen, because iOS shows notifications only there.
2. Sign in, select Alerts, then Turn on. Allow notifications.
3. Confirm that the test notification appears.
4. Lock the phone. Send a message from the widget on another device.
5. Confirm that a notification appears, and that selecting it opens that conversation.

Write the phone, the system version and the result in the pull request that changed `sw.js`, or in the release notes.

A phone can delay or drop a notification, so a passed check does not guarantee delivery.
