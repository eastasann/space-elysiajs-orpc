# syntax=docker/dockerfile:1
#
# One Dockerfile, four runtime targets. The build context is the repository
# root so that workspace packages resolve exactly as they do locally.
#
#   docker build -f infra/docker/Dockerfile --target api .
#
# Targets: api | worker | web | admin

# ---------------------------------------------------------------------------
# base — the shared runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# ---------------------------------------------------------------------------
# deps — dependency installation, cached independently of source changes
#
# Only manifests are copied first: editing application code then costs a source
# copy, not a reinstall.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json bun.lock ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/api-contract/package.json packages/api-contract/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY tooling/local-runner/package.json tooling/local-runner/package.json
COPY tooling/loop/package.json tooling/loop/package.json
# Networks that intercept TLS (corporate proxies, some CI egress gateways) can
# drop connections when many run at once, which surfaces as spurious
# certificate errors. Lower this to build behind one:
#   docker compose build --build-arg BUN_NETWORK_CONCURRENCY=8
ARG BUN_NETWORK_CONCURRENCY=48
RUN bun install --frozen-lockfile --network-concurrency "${BUN_NETWORK_CONCURRENCY}"

# ---------------------------------------------------------------------------
# source — dependencies plus application code
# ---------------------------------------------------------------------------
FROM deps AS source
COPY . .

# ---------------------------------------------------------------------------
# api — Elysia + oRPC
#
# Bun executes TypeScript directly, so there is no bundling step. That also
# avoids bundling BullMQ, which loads Lua scripts from disk at runtime.
# ---------------------------------------------------------------------------
FROM source AS api
ENV API_PORT=3001
EXPOSE 3001
USER bun
CMD ["bun", "apps/api/src/index.ts"]

# ---------------------------------------------------------------------------
# worker — background jobs
# ---------------------------------------------------------------------------
FROM source AS worker
ENV WORKER_PORT=3002
EXPOSE 3002
USER bun
CMD ["bun", "apps/worker/src/index.ts"]

# ---------------------------------------------------------------------------
# migrate — one-shot schema migration, run to completion before the apps start
# ---------------------------------------------------------------------------
FROM source AS migrate
USER bun
CMD ["bun", "packages/db/src/migrate.ts"]

# ---------------------------------------------------------------------------
# web-build / web — user-facing TanStack Start application
#
# Nitro emits a self-contained server bundle, so the runtime image carries no
# node_modules and no source.
# ---------------------------------------------------------------------------
FROM source AS web-build
RUN cd apps/web && bun run build

FROM base AS web
COPY --from=web-build /app/apps/web/.output ./.output
ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", ".output/server/index.mjs"]

# ---------------------------------------------------------------------------
# admin-build / admin — administration application
# ---------------------------------------------------------------------------
FROM source AS admin-build
RUN cd apps/admin && bun run build

FROM base AS admin
COPY --from=admin-build /app/apps/admin/.output ./.output
ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", ".output/server/index.mjs"]
