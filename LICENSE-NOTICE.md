# Licenses in this repository

Dinghy is open core. Almost all of it is open source, and one folder holds the code that only Dinghy Cloud runs.

| Path              | License                                 |
| ----------------- | --------------------------------------- |
| `packages/widget` | [MIT](packages/widget/LICENSE)          |
| `ee/`             | [Dinghy Enterprise License](ee/LICENSE) |
| Everything else   | [AGPL 3.0](LICENSE)                     |

`ee/` holds Dinghy Cloud's billing, its Stripe Checkout, customer portal and webhook, the subscription lifecycle, cloud signup, the cloud plan's limits and its image retention. Its license lets anyone read, change and test the code for development, and run the unmodified code in production as part of Dinghy while the cloud features stay off. Turning them on, running a changed copy in production, or offering the cloud features as a service needs a written agreement with OnceByte, LLC. Hosting Dinghy for others with the cloud features off needs none.

A self-hosted install has every product feature: the inbox, the widget, the team, alerts, images, exports, backups and workspace deletion are all AGPL. The Docker image ships `ee/`, and a self-hosted install never turns it on: the code stays inactive unless one of the cloud's settings (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` or `CLOUD_SIGNUP`) is set, and a self-hosted install leaves them all unset. The `ee/` license allows running it that way in production, with no agreement. Dinghy has no license key and no license check.

Contributions to any part of the repository are under the [contributor license agreement](CLA.md).
