# Dinghy for iOS and Android

This development app signs operators in with an emailed code entered in the app. Operators with two-step verification then enter an authenticator or recovery code. Sign-in does not open a browser or WebView.

The app opens the inbox, receives conversation alerts and keeps an unsent reply for each conversation on the phone. Sending moves the text into the local outbox until the server accepts it.

Operators can insert a saved reply and edit it before sending. **Photo** opens the system picker and shows a preview before upload. **Private note** opens a separate composer for the team. Photos and private notes need a connection to send.

## Run a development build

Install the repository dependencies with `bun install`. From `apps/mobile`, run `bun run ios` on a Mac with Xcode or `bun run android` with the Android SDK. Each command builds the native app and starts Metro.

Use a server that includes the mobile sign-in routes. To use a local server, run `DINGHY_PORT=4620 bun run dev` from the repository root. Set `EXPO_PUBLIC_DINGHY_ORIGIN=http://localhost:4620` when starting Metro. For an Android emulator, also run `adb reverse tcp:4620 tcp:4620`. Release builds use the Dinghy Cloud address for the Cloud sign-in option, unless `EXPO_PUBLIC_DINGHY_ORIGIN` holds a loopback address at build time, as in the simulator build for the App Store screenshots.

## Push alerts

The iOS bundle identifier and Android application ID are `chat.dinghy.operator`. Configure the provider for the platforms you use in the server's `settings`. The example settings list the Apple and Firebase fields. A phone receives alerts while its operator session is valid. Signing in again restores alerts after expiry. Apple development builds use the sandbox. A distribution build needs the matching production entitlement and provider environment.

For Android, set `GOOGLE_SERVICES_JSON` to the path of the Firebase Android configuration before generating the native project. Re-run `bun x expo prebuild` and build the app after changing native configuration. Keep signing files and provider credentials outside the repository.

## Check delivery on a phone

1. Sign in, allow notifications, enable push for incoming conversations, and lock the phone.
2. Send a message from the widget. Tap its alert and check the visitor and message.
3. Disconnect the network and send a reply. Quit and reopen the app.
4. Reconnect, open the thread and retry the saved reply. Check that the widget received it once.
5. Sign out. Send another visitor message and check that the signed-out phone receives no alert.
