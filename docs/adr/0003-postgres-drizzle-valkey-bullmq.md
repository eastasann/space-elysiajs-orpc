# 0003 — PostgreSQL with Drizzle; Valkey with BullMQ

**Status:** accepted

## Context

The platform needs durable relational state (users, sources, articles,
engagement) and a job queue for feed ingestion, both runnable entirely locally
under Docker.

## Decision

**PostgreSQL 17** for durable state, accessed through **Drizzle ORM** over
`postgres.js`. Schema is defined in TypeScript; migrations are generated from
the schema diff and committed as reviewable SQL. `postgres.js` runs under both
Bun and Node, so `drizzle-kit` and the applications share one driver.

**Valkey 8** for cache and queue. Valkey is the BSD-licensed fork of Redis 7.2,
maintained under the Linux Foundation, and is wire-compatible — Redis itself
moved to a source-available licence at 7.4. Choosing Valkey keeps the default
local stack fully open source; any Redis-compatible service can be substituted
via `REDIS_URL`.

**BullMQ** for background jobs, on top of Valkey. It provides retries, delayed
and repeating jobs, and a failed set that survives inspection — all of which the
ingestion pipeline and the admin "failed job inspection" view need.

## Consequences

- Every schema change is a generated, reviewed migration. A one-shot `migrate`
  service applies them before any API replica starts.
- Job payloads are validated against a Zod schema before a handler runs, because
  a queue outlives any single deploy.
- BullMQ loads Lua scripts from disk at runtime, so the API and worker images
  run from source with `node_modules` present rather than from a bundle.
- Cost: BullMQ is a real dependency where a plain Redis list would be smaller.
  It is justified by retries, scheduling and failed-job visibility, all of which
  are product requirements rather than speculation.
- Cost: Valkey is less widely deployed than Redis. The wire protocol is the
  same, and nothing in the code names Valkey.
