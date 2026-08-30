# 0006 — Pin TypeScript 5.9, not 7

**Status:** accepted · revisit when the ecosystem settles

## Context

TypeScript 7 — the Go-native compiler — is the current `latest` on npm, with 6.x
published alongside it. The stack leans hard on type-level machinery: Elysia's
inference, oRPC's contract implementation types, Drizzle's schema inference, and
TanStack Router's generated route tree.

## Decision

Pin `typescript@5.9.3` for now.

5.9 is the release the whole dependency set is known to work against. The value
of a faster compiler does not outweigh the risk of a type-level divergence in
libraries whose whole benefit is inference — and where a divergence would show
up as a confusing error inside a dependency rather than in our own code.

`apps/api` and `apps/worker` have **no build step**: Bun executes TypeScript
directly, and bundling them would break BullMQ, which loads Lua scripts from
disk at runtime. `bun run typecheck` is therefore their compile-time gate, not a
secondary check — which is a further reason to keep the type checker boring.

## Consequences

- Typecheck is slower than it would be under the native compiler. At this size,
  seconds.
- Upgrading is a single Issue: bump the pin, run `bun run typecheck` across the
  workspace, and read the diff in errors.
- Because the API and worker are not bundled, their images carry `node_modules`
  and source. That is a size cost accepted in exchange for not fighting runtime
  file loading in a dependency.
