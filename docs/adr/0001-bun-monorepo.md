# 0001 — Bun workspaces plus Turborepo

**Status:** accepted

## Context

The repository holds four applications and eight packages that share types.
They must be developed together, built independently, and verified in CI without
a slow full-tree rebuild for every change.

## Decision

Bun is the runtime and package manager. Workspaces come from Bun; task
orchestration and caching come from Turborepo.

Bun 1.3 installs with an **isolated** `node_modules` layout, so a package can
only import what it declares. That turns a dependency-boundary violation into a
typecheck failure instead of something that works by accident through hoisting —
which matters here, because the client-safe boundary is load-bearing.

Turborepo caches `typecheck` and `build`, which are pure functions of the source
tree. `test` is explicitly **not** cached: integration tests talk to live
PostgreSQL and Valkey, so a cached pass could report success for a run that
never happened.

## Consequences

- One tool for install, run and test; no separate test runner dependency.
- Bun executes TypeScript directly, so `apps/api` and `apps/worker` need no
  build step (see ADR 0006 for what replaces it as the compile-time gate).
- Bun's test runner is used everywhere except E2E, so unit and integration tests
  share one API and one command.
- Cost: Bun is younger than Node. The mitigations are pinning an exact Bun
  version in `package.json` and in CI, and keeping the Docker images on the
  matching `oven/bun` tag.
- Cost: some tooling still assumes Node. `drizzle-kit` and Playwright both run
  fine under Bun today; if one stops, it can be run under the Node fallback
  binary that ships in the Bun image.
