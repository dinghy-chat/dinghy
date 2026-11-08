# Use the operator app

The operator app is where your team reads and answers chats. Open your Dinghy address in a browser, and sign in.

![The operator app with a conversation open](media/inbox.png)

## Answer a chat

New conversations appear in the **Open** list with no reload. Select one to read it, write in the reply box, and press **Send**.

To send an image, paste it, drag it onto the chat, or select the image button. The rules are the same as for visitors: PNG, JPEG or WebP, under 5 MB and under 16 megapixels.

If a message shows "Not sent", select it to try again. A retry cannot create a second copy.

If two of you open the same conversation, each sees "… is replying", so you do not answer twice.

In a conversation, you can also:

| Control | What it does |
|---|---|
| **Assign to** | A list that gives the conversation to one person on your team |
| **Close** | Moves it to the **Closed** list. **Reopen** brings it back. If the visitor writes after a close, this starts a new conversation with no assignee, and the visitor sees one thread |
| **Block** | Stops this visitor from sending messages. **Settings > Blocked visitors**, which appears once someone is blocked, can undo it |
| **Delete** | Deletes the conversation and its images for good. Owners and admins only |

For a signed-in user, the conversation shows the email and user ID that [your site sent](add-to-your-site.md#show-who-is-chatting).

## Get alerts

Select **Alerts** in the sidebar. Each device has its own setting.

- **Notifications on this device** sends a push notification when a visitor writes. Select **Turn on**, then **Send a test** to see if it works. A private window usually cannot turn this on.
- **Email me about new messages** needs a mail server on your Dinghy install. A burst of messages in one conversation sends one email.

On an iPhone, a web app can show notifications only from the Home Screen:

1. Open your Dinghy address in Safari.
2. Select Share, then **Add to Home Screen**.
3. Open Dinghy from the Home Screen, and turn on notifications there.

On Android and on a computer, you can install the app from the browser's menu, but it is not necessary.

A phone can delay or drop a notification, so do not rely on one for urgent work.

## Set up your team

![The settings page](media/settings.png)

Everyone can open **Settings**. An agent sees the team and the blocked visitors, and the other sections are for owners and admins.

To invite someone, select **Create a link** in **Invite someone**, and send the link to that one person. A link works once and lasts 7 days. The person opens it, and enters a name, an email and a password of at least 10 characters. If they already have an account, they select **I already have an account**. When the server can send email, they confirm their email from a link before they can sign in. Without a mail server, nothing checks the email, so send the link only to the person it is for.

| Role | Can do |
|---|---|
| **Agent** | Answer, assign, close and block |
| **Admin** | The above, and delete conversations, change settings, and invite or remove agents |
| **Owner** | The above, and invite admins, change roles, and download exports |

A workspace needs an owner, so make someone else owner before you leave.

Someone in two workspaces can switch between them at the top of the app.

## The other settings

- **Widget snippet** has the tag for your site.
- **Allowed sites** lists the sites that can load the chat.
- **Signing secret** is for [signed-in users](add-to-your-site.md#show-who-is-chatting).
- **Export** downloads all conversations and images as one file, which imports into a self-hosted Dinghy.

## If you forget your password

Select **Forgot your password?** on the sign-in page. This sends a link if your Dinghy install has a mail server. If it has none, the person who runs the server can make a new password:

```sh
docker compose exec app chat reset-password you@example.com
```
