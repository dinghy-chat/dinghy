# Security

## Report a problem

Email `hello@dinghy.chat`. Do not open a public issue, a pull request or a discussion about it.

Include:

- The version or commit you tested, and whether it was self-hosted or the cloud plan.
- The steps to reproduce the problem, with a proof of concept if you have one.
- What an attacker gains, and what they need first, such as an operator login or a visitor's browser.

Test only on an install you run yourself. Do not test on a server or a workspace that is not yours, and do not read, change or delete other people's data.

## What to report

Anything that lets someone do what Dinghy should stop. For example:

- Reading or changing another workspace's data.
- A visitor reading another visitor's messages or images.
- Signing in as an operator without their sign-in link, using a link twice or after 15 minutes, or keeping access after a sign-out or a removal from the team.
- Running script in the operator app or on a site that embeds the widget.
- Getting secrets from a server, such as database passwords or the signing secret.
- A way around the rate limits, a block or the allowed sites.

Not in scope: a missing security header with no attack that uses it, rate limits that a large botnet can get past, problems that need a compromised server or browser, and reports from automated scanners with no working attack.

## What to expect

- We read every report, and we answer when we have looked at it. We do not promise a time for that, because a small team runs Dinghy.
- We tell you whether we can reproduce the problem, and what we plan to do.
- We tell you when a fix is in a release. The changelog names the fix once it is out.
- We credit you in the changelog if you want that. Tell us the name to use.
- Please give us a reasonable time to ship a fix before you publish details.

## Supported versions

Fixes go to `main` and the newest release. Upgrade to the newest release to get them. [Upgrading](docs/self-hosting.md#upgrading) has the steps.
