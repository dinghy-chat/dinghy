# Use the operator app

The operator app is where your team reads and answers chats. Open your Dinghy address in a browser, enter your email, and select **Email me a sign-in link**. Open the link in the email, and select **Sign in**. The link works once, for 15 minutes, and only the button uses it, so a mail scanner that opens it first does no harm. Dinghy has no passwords.

![The operator app with a conversation open](media/inbox.png)

## Answer a chat

The sidebar has **Inbox**, **Contacts**, **Visitors**, **Analytics** and **Settings**. Until the first steps are done, owners and admins also see **Get started** above their name, with a ring and a count such as 2/6. It lists six steps, each of which opens its page: install the widget (done once a page of an allowed site loads it), add a logo, customize the widget, invite a teammate, turn on notifications for yourself, and send a test chat. Dinghy checks each one itself. **Hide for good** hides the steps for you on every device. New conversations appear in the **Inbox** with no reload, and the red number counts the people who wait for a reply. At the top of the list, the **Open** and **Closed** switch picks which conversations it shows. In a team of more than one, **All**, **Mine** and **Unassigned** below it pick whose. The app remembers both in the address, so a reload or a shared link keeps them. Select one to read it, write in the reply box, and press Enter or the send button. If your site sends details with `setContext()`, they show under **Details from your website**. Visitors can change these details in their browser, so do not use them to verify identity or account access.

Messages can carry a little formatting, written as Markdown: `**bold**`, `*italic*`, `` `code` ``, a block between two lines of three backticks, `[words](https://example.com)` for a link, and lines that start with `-` or `1.` for a list. A web address becomes a link by itself. The buttons under the reply box, and Cmd or Ctrl with B, I, E and K, add the marks around the selected words. Visitors see the formatting in the widget and in reply emails, and can type it too. Links open in a new tab, and only `http`, `https` and `mailto` links work. HTML, images and headings stay plain text.

To send an image, paste it, drag it onto the chat, or select the image button. The rules are the same as for visitors: PNG, JPEG or WebP, under 5 MB and under 16 megapixels.

If a message shows "Not sent", select it to try again. A retry cannot create a second copy.

When you close a conversation, a visitor who gave an email gets the whole conversation by email 5 minutes later, if someone on the team replied, with a link to continue the chat. Reopening it within the 5 minutes cancels it. **Send transcript** in the conversation's **…** menu sends it now. **Settings > Appearance** turns the email at close off.

Under your team's last reply, a small line says how far it got: **Sent** when Dinghy stored it, **Sent by email** when a reply email carried it to the visitor, **Email failed** when that email could not go, and **Read in chat** once the visitor has seen it in the widget. Point at an earlier reply to see its line. The line changes by itself when the visitor reads.

If two of you open the same conversation, each sees "… has this conversation open", so you do not answer twice. It means only that the conversation is open on their screen.

While a visitor with an open conversation types in the widget, the thread shows their words in a faded bubble with moving dots, and the Inbox shows **typing…** in place of the last message. It goes when they send, empty the box, or stop for 6 seconds. Dinghy does not store these words. An owner or admin turns this off with **Show what visitors type before they send** in **Settings > Workspace**, and then the widget sends nothing until the visitor sends.

**Visitors** shows who is on your site now: a world map with a yellow dot for each country, larger with more people, and below it each open page with its country, the visitor's local time, the page, how long they have been on the site, their device and where they came from. A visitor who has chatted shows their name and **Chatting**, which opens their conversation. The number next to **Visitors** in the sidebar counts them. A tab leaves the list a minute and a half after it closes or goes to the background. [What the widget sends](add-to-your-site.md#what-operators-see-about-a-visitor) explains what this collects.

To find a conversation, type at least three characters in the search box above the list. It searches open and closed conversations by the visitor's name, email or user ID, and by what anyone wrote, and shows the matching message under each one. Press Escape or empty the box to go back to the list.

Under the visitor's name, the header shows their email and user ID, when the name does not already show them, and the page where they started. The next line shows **Chat is open** while the visitor has the chat open, or when they were last seen, then their browser and system, such as "Chrome on macOS". Below that is the last page they were on, which opens in a new tab; when it is the page where they started, the header names it only once. If Dinghy cannot tell whether they are online, it says nothing about it. On the right are the controls:

| Control | What it does |
|---|---|
| The assignee | A list that gives the conversation to one person on your team, or to nobody |
| **Close** | Moves it under **Closed** in the Inbox. **Reopen** brings it back. If the visitor writes after a close, this starts a new conversation with no assignee, and the visitor sees one thread |
| **…** then **Block** | Stops this visitor from sending messages. **Unblock** in the same place undoes it, and so does **Blocked visitors** in **Settings > Workspace** |
| **…** then **Delete** | Deletes the conversation and its images for good, after you confirm. Owners and admins only |

For a signed-in user, the conversation shows the name, email, user ID and custom attributes that [your site sent](add-to-your-site.md#show-who-is-chatting). An attribute that is a web address is a link.

On the right of a conversation, a panel shows who the visitor is: their name, email and whether the chat is open, the assignee and status, then folds for **Visitor** (country with its flag, their local time, device and current page), **Details** (the signed attributes and what the page sent), **Pages visited**, **Other conversations** of the same person, and a **Note** that only your team sees, saved when you click away. Each fold opens or closes, and the browser remembers it. The button at the right of the header shows or hides the panel. On a screen under 1200 pixels wide, it opens over the conversation instead.

**View contact** opens the person's page under **Contacts** in the sidebar. **Contacts** lists everyone who has started a conversation, with their company (a signed `company` attribute), country, when they were last seen and first seen, and how many conversations they had. Search by name, email or user ID, sort by last or first seen, and **Export CSV** downloads them all. A contact's page has the same folds, every conversation, and for a visitor your site did not sign in, their name and email, which you can correct. Owners and admins can **Delete contact**, which deletes the person with all their conversations, messages and images.

**Pages visited** lists the pages the visitor went through after they first chatted, newest first, with how long ago. Each one shows the page's title, or its address when it has none, and opens in a new tab. It shows 5, and **Show all** shows up to 20. The list reads the pages again every 30 seconds. Dinghy keeps a visitor's newest 100 pages for 90 days, and deleting the visitor's last conversation deletes them.

## See how support is going

Select **Analytics** in the sidebar. Every member can see it. Pick the last 7, 30 or 90 days in the list at the top right. Days and hours are in your browser's time zone, which the line under the title names.

Every number is about the conversations that started in that period:

| Number | What it means |
|---|---|
| **Conversations started** | How many started |
| **First reply time (median)** | Half of the answered ones got their first reply within this time, counted from the conversation's start. Unanswered ones do not count |
| **First reply time for 90% of answered chats** | 9 in 10 of the answered ones got their first reply within this time. Unanswered ones do not count |
| **First reply within 5 minutes** | The share of all of them, answered or not, with a first reply within 5 minutes |
| **Started in this period and now closed** | How many of them are closed now |

A first reply can come from a person on your team or from software that uses an [API key](api.md#api-keys). Both count. On Dinghy Cloud, the welcome chat counts nowhere.

Below are the conversations per day, **Who sent the first reply**, by person or API key, and the busiest hours, as a grid of weekdays by hours where a darker square means more conversations started then. Hold the pointer over a bar or a square to see its number. With no conversation in the period, the page says so.

## Get alerts

Open **Settings > Notifications**. These settings affect only you, and each one has its own scope.

- **Browser notifications** sends a push notification when a visitor writes. It is set per browser, and covers every workspace you are in. Turn it on in each browser you use. Select **Turn on**, then **Send a test** to see if it works. A private window usually cannot turn this on.
- **Email me about new messages** is set per workspace, so turn it on in each workspace where you want emails. It needs a mail server on your Dinghy install. A burst of messages in one conversation sends one email.
- **Play a sound for new messages** is set per browser. It plays a short chime when a visitor writes in a conversation you don't have open, or while the app's window is in the background. It is on unless you turn it off. The browser plays it only after your first click or key press in the app. A tab you are not on holds no live connection, so it stays silent: turn on notifications for that.

On an iPhone, a web app can show notifications only from the Home Screen:

1. Open your Dinghy address in Safari.
2. Select Share, then **Add to Home Screen**.
3. Open Dinghy from the Home Screen, and turn on notifications there.

On Android and on a computer, you can install the app from the browser's menu, but it is not necessary.

A phone can delay or drop a notification, so do not rely on one for urgent work.

## Your profile

Select your name at the bottom of the sidebar, then **Profile**. This opens **Settings > Profile**, where you change the name your teammates see. Visitors see only your first name, next to your replies. **Sign out** is in the same menu.

**Picture** in **Profile** sets your picture from a PNG, JPEG or WebP of up to 2 MB. Dinghy cuts it to a square. Visitors see it next to your replies and at the top of the chat, and your team sees it in place of your initials in the inbox, a conversation and **Team**. It is the same in every workspace.

**Theme** picks light, dark or **Use device setting** for the operator app. It applies only to this browser.

### Delete your account

**Delete my account** is in **Profile** too, on the payment screen, on the screen that asks for an invite, and on the workspace setup once you have been in a workspace. It takes you out of every workspace, ends your sessions, and erases your name and email. The workspaces keep their conversations, and your old replies show as from "Former team member".

A workspace where you are the only owner does not stop the delete. If other people are in it, the admin who joined first becomes its owner, or, with no admin, the member who joined first. If nobody else is in it, it is deleted with your account, with all its conversations, and on Dinghy Cloud its subscription ends. The dialog lists what happens to each of these workspaces before you confirm.

A self-hosted server keeps its last workspace. If you are the only person in it, your account stays. To delete your workspaces one by one instead, use **Delete workspace** on each workspace's **Workspace** page.

With a mail server, Dinghy emails you a confirmation link. Open it within 15 minutes, then select **Delete my account**. Opening the link deletes nothing. Without a mail server, you type your email to confirm, and the account goes at once.

## Set up your team

Everyone can open **Settings**. A list on its left groups the pages:

| Group | Pages |
|---|---|
| **You** | **Profile**, **Notifications** |
| **Workspace** | **Workspace**, **Team** |
| **Chat widget** | **Appearance**, **Install** |
| **Developers** | **API & webhooks** |

Each page has its own address, such as `/settings/team?workspace=<id>`, so a reload, a bookmark or a shared link opens the same page of the same workspace. On a phone, the list is its own screen, and **Back** on a page returns to it. A member sees **Profile**, **Notifications**, **Team** and **Appearance**, and cannot change the team or the chat's look. Owners and admins see every page.

To invite someone, open **Settings > Team**, select **Invite someone** at the top of the page, enter their email, pick a role, and select **Send invite**. Dinghy emails them a link to join. Without a mail server, select **Create invite link** instead, and send the link to that one person. Pending invites show in the team list with their email and the days they have left. Select the trash icon, then **Cancel invite**, to cancel one. To send an invite again, invite the same email again: the old link stops working. A link works once and lasts 7 days, and only that email can use it.

Someone new opens the link, enters a name and selects **Join**. That creates their account, joins the workspace and signs them in. Someone who already has an account with that email selects **Join**, and Dinghy emails them a link that joins the workspace and signs them in. Someone already signed in with that email selects **Join** at once. Without a mail server, nothing checks the email, so send the link only to the person it is for. Someone who already has an account there signs in first, then opens the invite.

| Role | Can do |
|---|---|
| **Member** | Answer, assign, close and block |
| **Admin** | The above, and delete conversations, change settings, and invite or remove members |
| **Owner** | The above, and invite admins, change roles, and download exports |

A workspace always keeps an owner. While you are the only one, your role stays **Owner** and you cannot leave: make someone else an owner first.

Someone in two workspaces switches between them with the workspace name at the top of the sidebar. On Dinghy Cloud, the same menu has **Create a workspace**.

## Change the widget

**Settings > Appearance** changes how the chat looks and behaves on your site, with no code. The preview beside the form shows each change before you save: the open chat, with the chat button under it, in light or dark colors. On a phone, the preview sits above the form, and **Hide the preview** folds it away.

- **Chat text**: the chat's title, its greeting before the first message and its message for when nobody is online. An empty field keeps Dinghy's own text.
- **Colors and layout**: the main color and the accent color, the side of the page, the theme (light, dark, or **Use device setting**, which follows the visitor's device), the chat button (a bubble, a label with the chat's title, a square, a boat, or hidden so your own button opens the chat), the corner rounding, and whether the open chat shows the boat.
- **Email and branding**: when to ask visitors for their email, so you can reply after they leave: never, after their first message, or before it. Dinghy never asks a signed-in user, nor anyone when your server sends no email. A switch hides the "Powered by Dinghy" line under the chat.

**Save** sends the form. Pages of your site that open after the save show the change within 5 minutes, and a page already open keeps the look it loaded with. The browser asks before you leave the page with a change you did not save. The top of the chat shows the workspace's logo, which you change in **Settings > Workspace**. It also shows up to 3 members who replied last, by first name and picture. Attributes in your site's tag win over these settings: see [Add the chat to your website](add-to-your-site.md#change-how-it-looks).

## The other settings

**Settings > Install** has three sections. Owners and admins see it.

![The Install page in Settings](media/settings.png)

- **Install code** has the tag for your site, with a **Copy** button.
- **Allowed sites** lists the sites that can load the chat, one per row. **Add a site** adds a row, and each row says if its address is not a site such as `https://example.com`.
- **Identify signed-in users (optional)** holds the identity signing secret, for [signed-in users](add-to-your-site.md#show-who-is-chatting). Ordinary chat does not need it. It stays hidden until you select the eye. **Replace the secret** asks first, because the old one stops working at once.

**Settings > API & webhooks** has the workspace's [API keys](api.md#api-keys), for your own scripts and AI assistants, and its [webhooks](api.md#webhooks), which tell another app about new conversations and messages. Both are optional. A key's token and a webhook's secret show once, so copy them then. A key's replies show its name, and **Revoke** stops it at once. Owners and admins see this page.

**Settings > Workspace** is for owners and admins. It has these sections:

- **Workspace name**: owners and admins change it here, and the sidebar shows the new name at once.
- **Logo**: it shows in the workspace menu and at the top of the chat, in place of the boat. Use a square PNG, JPEG or WebP of up to 2 MB. It saves as soon as you pick it.
- **Plan and usage**, on Dinghy Cloud only. See [Plan and usage](#plan-and-usage).
- **Billing**, on Dinghy Cloud, for owners. See [Billing](#billing).
- **Blocked visitors**, once someone is blocked, with **Unblock** for each one.
- **Export workspace**, for owners: **Download an export** saves the workspace's conversations, images, team and settings as one file, which imports into another Dinghy server. See [Moving a workspace](self-hosting.md#moving-a-workspace).
- **Delete workspace**, for owners. See [Deleting a workspace](self-hosting.md#deleting-a-workspace).

## Plan and usage

This applies to Dinghy Cloud only. A self-hosted server has no plan limits.

Each workspace on Dinghy Cloud includes up to 5 team members and 1 GB of image storage. **Settings > Workspace** shows how much of each is in use, and the **Team** page says how many of the 5 places are taken.

- **Team members**: pending invites count toward the limit, because each one can still become a member. An invite stops counting once it is used, canceled or expired, after 7 days. To free a place, remove someone in **Settings > Team**, or cancel a pending invite.
- **Image storage**: the images sent in chats count, by their stored size. Dinghy Cloud deletes each image automatically 12 months after it was sent, and the conversation shows "Image removed after 12 months" in its place. The text stays. To free space now, an owner or admin deletes conversations that hold images. When an image does not fit in the space left, Dinghy refuses it, for your team and for visitors.

## Billing

This applies to Dinghy Cloud only. A self-hosted server has no billing.

Dinghy Cloud costs $7 a month per workspace, and Stripe takes the payment. You pay when you create the workspace: after you name it, Dinghy opens Stripe's checkout, and the workspace opens once Stripe confirms the payment. Only an owner pays. A member who opens an unpaid workspace sees that it waits for an owner. The subscription renews each month.

An owner sees the subscription's state in **Settings > Workspace**, under **Billing**. **Manage billing** opens Stripe, where you change the card, see invoices or cancel. A canceled subscription keeps the workspace working until the end of the month you paid for, and the owners get an email 3 days before that end.

If a payment fails, the workspace keeps working for 7 days, and the owners get emails about it. A banner asks the owner to update the card. If no payment succeeds in those 7 days, Dinghy ends the subscription.

When the subscription ends, the workspace becomes read-only for 90 days. The chat widget is off, and nobody can reply to visitors. Your team can still sign in, read the conversations and download an export. The owners get an email 30 days and 7 days before the deletion. To keep the workspace, an owner selects **Restart subscription** in the banner above the inbox, and pays again through Stripe. After the 90 days, Dinghy deletes the workspace and its data.

Deleting a workspace yourself ends its subscription that day, with no refund.

## If no sign-in link arrives

Check your spam folder, and ask for another link. Each one works once, for 15 minutes, and an email gets at most 20 links an hour.

If your Dinghy install has no mail server, the sign-in page says so. Then the person who runs the server makes a link for you:

```sh
docker compose exec app chat sign-in-link you@example.com
```
