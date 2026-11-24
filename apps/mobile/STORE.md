# App Store release

`scripts/app-store.ts` writes the Dinghy Chat listing to App Store Connect through Apple's API. The copy lives in `store/listing.ts`. The version comes from `version` in `app.config.js`, and the build from `ios.buildNumber`. The only step left in App Store Connect is App Privacy, because Apple's API cannot set it.

The script needs Node 24 and nothing else. Run every command from the repository root.

## 1. Screenshots

Capture and compose the screenshots with `node apps/mobile/scripts/store-screenshots.ts`. It writes one 1320x2868 PNG per slide in `store/listing.ts` to `apps/mobile/store/output/composed/iphone-6.9`, named after the slide, such as `01-inbox.png`.

## 2. Environment

- `ASC_ISSUER_ID`: 1Password, vault Dinghy, item "App Store Connect API key (Dinghy uploads)", field `issuer_id`.
- `ASC_KEY_ID`: defaults to `B482423883`.
- `ASC_KEY_PATH`: defaults to `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`.
- `ASC_REVIEW_CONTACT_FIRST_NAME`, `ASC_REVIEW_CONTACT_LAST_NAME`, `ASC_REVIEW_CONTACT_PHONE` and `ASC_REVIEW_CONTACT_EMAIL`: Infisical.
- `ASC_DEMO_EMAIL`: `review@dinghy.chat`, the review account on Dinghy Cloud.
- `ASC_DEMO_CODE`: Infisical prod, as `CLOUD_APP_REVIEW_CODE`.

The script never prints the key, the token or the demo code.

## 3. Commands

1. `node apps/mobile/scripts/app-store.ts check` compares App Store Connect with the listing, field by field. It reads and never writes. It exits 1 while something is missing or different.
2. `node apps/mobile/scripts/app-store.ts push --dry-run` prints every write that `push` would make.
3. `node apps/mobile/scripts/app-store.ts push` writes the listing, the categories, the age rating, the review details, the screenshots and the price, and attaches the build once Apple marks it VALID. Add `--build <number>` for another build, or `--screenshots <dir>` for another folder. It changes only a version that Apple lets you edit. Run it again after a build finishes processing.
4. `node apps/mobile/scripts/app-store.ts check` again, until it says the version is ready for review.
5. `node apps/mobile/scripts/app-store.ts submit` runs the check and shows what it would submit.
6. `node apps/mobile/scripts/app-store.ts submit --yes` submits the version for review. It refuses while another submission is open.

The age rating answers no to every question except messaging and chat, and user-generated content, because operators read messages that website visitors write. When Apple adds a question that the script does not know, `push` names it, and you answer it in App Store Connect under App Information, Age Rating.

## 4. App Privacy

Apple's API keys cannot set App Privacy, so it goes through fastlane, which signs in with an Apple ID of the team. `store/app-privacy.json` holds the answers. Run this on a Mac, then type the Apple ID password and the two-factor code when fastlane asks:

```sh
fastlane run upload_app_privacy_details_to_app_store app_identifier:chat.dinghy.operator \
  team_id:46DR2RY722 json_path:apps/mobile/store/app-privacy.json username:<apple id>
```

The answers change only when the app collects something new.

The app does not track people, shows no ads and uses no third-party analytics or crash reporting. Every item below is linked to the user, is used only for app functionality and is not used for tracking.

| Data type                      | What the app collects                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| Contact info: name             | The operator's name on their account                                       |
| Contact info: email address    | The email address the operator signs in with                               |
| User content: photos or videos | The operator's profile picture, and images they send in a conversation     |
| User content: customer support | The replies and notes the operator writes in conversations                 |
| Identifiers: user ID           | The operator's account ID on the Dinghy server                             |
| Identifiers: device ID         | The push notification token, so the server can send alerts about new chats |

Answer "No" for location, health, financial info, contacts, browsing history, search history, purchases, usage data, diagnostics and sensitive info.

The messages that website visitors send belong to the workspace, which decides how they are used. The app shows them to the operator and does not collect them for itself, so they are not listed. See `site/public/privacy.html`.
