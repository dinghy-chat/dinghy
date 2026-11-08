# Dinghy docs

Dinghy is a live support chat. Visitors chat from a small widget on your website, and your team answers from a web app.

## Start here

1. [Install Dinghy](self-hosting.md#the-quick-way) on a server. It takes one script.
2. [Add the chat to your website](add-to-your-site.md). It takes one tag.
3. [Learn the operator app](operator-guide.md), then invite your team and turn on alerts on your phone.

If something does not work, read [Troubleshooting](troubleshooting.md). If the server itself breaks, read the [Runbooks](runbooks.md).

## Run the server

- [Self-hosting](self-hosting.md) has the install, the settings, running behind your own proxy, backups, restore, upgrades and going back.
- [Runbooks](runbooks.md) say what to do when the disk is full, a service is down, mail fails or a release breaks.
- [Coolify and Dokploy](deploy-coolify-dokploy.md) says how the Compose file should fit those platforms. It is not tested on them yet.
- [Measurements](measurements.md) has what one small server can do, and what we have not measured.
- [Phone push check](phone-push-check.md) tests alerts on real phones.
- [Changelog](../CHANGELOG.md) says what changed in each release, and what you must do.

## Build on it

- [Architecture](architecture.md) explains how the processes, tenant isolation, messages, live signals and jobs fit together.
- [API](api.md) describes the HTTP API, and links its OpenAPI document at `/v1/openapi.json`.
