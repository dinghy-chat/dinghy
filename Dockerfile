# One image for every role. `web`, `worker` and `all` choose the process, and `chat ...` runs a command.
# Alpine, because pg_dump must match the Postgres major version, and Alpine packages it directly.

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS install
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/operator/package.json apps/operator/
COPY packages/widget/package.json packages/widget/
COPY ee/package.json ee/
RUN bun install --frozen-lockfile --ignore-scripts

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS bundles
WORKDIR /repo
COPY --from=install /repo ./
# Only what the two bundles import, so a server-only change does not build them again.
COPY apps/operator apps/operator
COPY packages/widget packages/widget
COPY ee/operator ee/operator
RUN node --input-type=module -e " \
  const { buildWidget } = await import('./packages/widget/build.ts'); \
  const { buildOperator } = await import('./apps/operator/build.ts'); \
  await buildWidget('/out/widget'); \
  await buildOperator('/out/operator');"

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS production
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/operator/package.json apps/operator/
COPY packages/widget/package.json packages/widget/
COPY ee/package.json ee/
# sharp's native parts come as packages for this architecture, so install scripts stay off.
# Hoisted, because the default store keeps every package in the lockfile. No peers, because the auth
# library lists build and test tools as optional peers, and Bun would install them.
RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted --omit=peer \
  && mkdir -p apps/server/node_modules ee/node_modules

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
# The major version in compose.yaml. pg_restore refuses a newer server, and the install check compares them.
# The server never uses npm or corepack, and the image scan finds their bundled packages.
# The upgrade takes Alpine's security fixes that the pinned base image does not have yet.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && apk upgrade --no-cache \
  && apk add --no-cache postgresql18-client \
  && mkdir -p /data/images /data/backups \
  && chown -R node:node /data \
  && printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts "$@"\n' > /usr/local/bin/chat \
  && printf '#!/bin/sh\nif [ "$1" = chat ]; then shift; exec chat "$@"; fi\nexec node /app/apps/server/src/main.ts "$@"\n' > /usr/local/bin/dinghy \
  && chmod 755 /usr/local/bin/chat /usr/local/bin/dinghy
WORKDIR /app
COPY --from=production /repo/node_modules node_modules
COPY --from=production /repo/apps/server/node_modules apps/server/node_modules
COPY --from=production /repo/ee/node_modules ee/node_modules
COPY apps/server/package.json apps/server/
COPY apps/server/drizzle apps/server/drizzle
COPY apps/server/src apps/server/src
# Dinghy Cloud's code, under ee/LICENSE. It stays inactive unless the cloud's settings are set.
COPY ee/package.json ee/LICENSE ee/
COPY ee/server ee/server
COPY LICENSE LICENSE-NOTICE.md ./
COPY --from=bundles /out/widget public/widget
COPY --from=bundles /out/operator public/operator
RUN find apps/server/src ee/server -name '*.test.ts' -delete
ENV NODE_ENV=production \
    WIDGET_DIR=/app/public/widget \
    OPERATOR_DIR=/app/public/operator \
    STORAGE_DIR=/data/images \
    BACKUP_DIR=/data/backups \
    MIGRATIONS_DIR=/app/apps/server/drizzle
USER node
EXPOSE 3000
# `web`, `worker` or `all` starts a process, and `chat ...` runs a command. The script uses exec, so
# Node becomes process 1, and `docker stop` reaches its signal handler with no shell in between.
ENTRYPOINT ["dinghy"]
CMD ["all"]
