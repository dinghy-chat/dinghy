# Use the operator app

The operator app is where your team reads and answers chats. Open your Dinghy address in a browser, enter your email, and select **Email me a sign-in link**. Open the link in the email, and select **Sign in**. The link works once, for 15 minutes, and only the button uses it, so a mail scanner that opens it first does no harm. Dinghy has no passwords.

![The operator app with a conversation open](media/inbox.png)

## Answer a chat

The sidebar has **Inbox**, **Closed**, **Alerts** and **Settings**. New conversations appear in the **Inbox** with no reload, and the red number counts the people who wait for a reply. Select one to read it, write in the reply box, and press Enter or the send button. If your site sends details with `setContext()`, they show under **From the page**. Your site does not sign them, so treat them as a hint.

To send an image, paste it, drag it onto the chat, or select the image button. The rules are the same as for visitors: PNG, JPEG or WebP, under 5 MB and under 16 megapixels.

If a message shows "Not sent", select it to try again. A retry cannot create a second copy.

If two of you open the same conversation, each sees "… is replying", so you do not answer twice.

To find a conversation, type at least three characters in the search box above the list. It searches open and closed conversations by the visitor's name, email or user ID, and by what anyone wrote, and shows the matching message under each one. Press Escape or empty the box to go back to the list.

Under the visitor's name, the header shows their email and user ID, when the name does not already show them, and the page where they started. The next line shows **Online now** while the visitor has the chat open, or when they were last seen, then their browser and system, such as "Chrome on macOS". Below that is the last page they were on, which opens in a new tab; when it is the page where they started, the header names it only once. If Dinghy cannot tell whether they are online, it says nothing about it. On the right are the controls:

| Control | What it does |
|---|---|
| The assignee | A list that gives the conversation to one person on your team, or to nobody |
| **Close** | Moves it to the **Closed** list. **Reopen** brings it back. If the visitor writes after a close, this starts a new conversation with no assignee, and the visitor sees one thread |
| **…** then **Block** | Stops this visitor from sending messages. **Unblock** in the same place undoes it, and so does **Settings > Data > Blocked visitors** |
| **…** then **Delete** | Deletes the conversation and its images for good, after you confirm. Owners and admins only |

For a signed-in user, the conversation shows the name, email, user ID and custom attributes that [your site sent](add-to-your-site.md#show-who-is-chatting). An attribute that is a web address is a link.

The attributes and the pages sit in **Visitor details**, below the header. It starts open on a computer and folded on a phone, so the messages keep the screen; select it to open or fold it.

**Pages visited** lists the pages the visitor went through after they first chatted, newest first, with how long ago. Each one shows the page's title, or its address when it has none, and opens in a new tab. It shows 5, and **Show all** shows up to 20. The list reads the pages again every 30 seconds. Dinghy keeps a visitor's newest 100 pages for 90 days, and deleting the visitor's last conversation deletes them.

## See how support is going

Select **Analytics** in the sidebar. Every member can see it. Pick the last 7, 30 or 90 days in the list at the top right. Days and hours are in your browser's time zone, which the line under the title names.

Every number is about the conversations that started in that period:

| Number | What it means |
|---|---|
| **Conversations** | How many started |
| **Median first reply** | Half of the answered ones got their first reply from your team within this time, counted from the visitor's first message |
| **90% replied within** | 9 in 10 of the answered ones got their first reply within this time |
| **Answered within 5 min** | The share of all of them, answered or not, with a first reply within 5 minutes |
| **Closed now** | How many of them are closed now |

Below are the conversations per day, the conversations each person answered first, and the busiest hours, as a grid of weekdays by hours where a darker square means more conversations started then. Hold the pointer over a bar or a square to see its number. With no conversation in the period, the page says so.

## Get alerts

Select **Alerts** in the sidebar. Each device has its own setting.

- **Notifications on this device** sends a push notification when a visitor writes. Select **Turn on**, then **Send a test** to see if it works. A private window usually cannot turn this on.
- **Email me about new messages** needs a mail server on your Dinghy install. A burst of messages in one conversation sends one email.
- **Play a sound for new messages** plays a short chime when a visitor writes in a conversation you don't have open, or while the app's window is in the background. It is on unless you turn it off. The browser plays it only after your first click or key press in the app. A tab you are not on holds no live connection, so it stays silent: turn on notifications for that.

On an iPhone, a web app can show notifications only from the Home Screen:

1. Open your Dinghy address in Safari.
2. Select Share, then **Add to Home Screen**.
3. Open Dinghy from the Home Screen, and turn on notifications there.

On Android and on a computer, you can install the app from the browser's menu, but it is not necessary.

A phone can delay or drop a notification, so do not rely on one for urgent work.

## Your profile

Select your name at the bottom of the sidebar, then **Profile**, to change the name your teammates see. **Sign out** is in the same menu.

**Delete my account** is in **Profile** too. It takes you out of every workspace, ends your sessions, and erases your name and email. The workspaces keep their conversations, and your old replies show as from "Former team member".

A workspace where you are the only owner blocks the delete. The dialog lists each one, with a way to delete it or to make someone else its owner. A self-hosted server keeps its last workspace, so if it is one of these, make someone else its owner.

With a mail server, Dinghy emails you a link that confirms the delete. It works once, for 15 minutes. Without one, you type your email to confirm, and the account goes at once.

## Set up your team

![The settings page](media/settings.png)

Everyone can open **Settings**. Its tabs are **Team**, **Install**, **Allowed sites**, **Signing secret**, **API** and **Data**. A member sees the team, and the blocked visitors under **Data** once someone is blocked. The other tabs are for owners and admins.

To invite someone, select **Invite someone** at the top of Settings, enter their email, pick a role, and select **Send invite**. Dinghy emails them a link to join. Without a mail server, select **Create invite link** instead, and send the link to that one person. Pending invites show in the team list with their email and the days they have left. Select the trash icon and confirm to revoke one. To send an invite again, invite the same email again: the old link stops working. A link works once and lasts 7 days, and only that email can use it.

Someone new opens the link, enters a name and selects **Join**. That creates their account, joins the workspace and signs them in. Someone who already has an account with that email selects **Join**, and Dinghy emails them a link that joins the workspace and signs them in. Someone already signed in with that email selects **Join** at once. Without a mail server, nothing checks the email, so send the link only to the person it is for. Someone who already has an account there signs in first, then opens the invite.

| Role | Can do |
|---|---|
| **Member** | Answer, assign, close and block |
| **Admin** | The above, and delete conversations, change settings, and invite or remove members |
| **Owner** | The above, and invite admins, change roles, and download exports |

A workspace always keeps an owner. While you are the only one, your role stays **Owner** and you cannot leave: make someone else an owner first.

Someone in two workspaces switches between them with the workspace name at the top of the sidebar. On Dinghy Cloud, the same menu has **Create a workspace**.

## The other settings

- **Install** has the tag for your site, with a **Copy** button, then the chat's title, its greeting in an empty chat and its text for when nobody is online. An empty box keeps Dinghy's own words.
- **Allowed sites** lists the sites that can load the chat, one per row. **Add a site** adds a row, and each row says if its address is not a site such as `https://example.com`.
- **Signing secret** is for [signed-in users](add-to-your-site.md#show-who-is-chatting). It stays hidden until you select the eye. **Replace the secret** asks first, because the old one stops working at once.
- **API** has the workspace's [API keys](api.md#api-keys), for your own scripts and AI agents, and its [webhooks](api.md#webhooks), which tell your server about new conversations and messages. A key's token and a webhook's secret show once, so copy them then. A key's replies show its name, and **Revoke** stops it at once.
- **Data** has **Download an export**, which saves all conversations and images as one file that imports into a self-hosted Dinghy, and **Delete workspace**.
- On Dinghy Cloud, **Team** also shows how many of the plan's 5 operators and 1 GB of images are in use.

## If no sign-in link arrives

Check your spam folder, and ask for another link. Each one works once, for 15 minutes, and an email gets at most 20 links an hour.

If your Dinghy install has no mail server, the sign-in page says so. Then the person who runs the server makes a link for you:

```sh
docker compose exec app chat sign-in-link you@example.com
```
