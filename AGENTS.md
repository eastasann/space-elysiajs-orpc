# AGENTS.md

Durable instructions for coding agents working in this repository.

Read this before touching anything. It is not a description of the product —
that is [`README.md`](README.md) and [`docs/architecture.md`](docs/architecture.md).
It is how work gets done here.

---

## 1. The working loop

Development happens one GitHub Issue at a time. The backlog, in dependency
order, is [`docs/roadmap.md`](docs/roadmap.md). For every Issue:

1. **Read the entire Issue.** Including Context, Technical Notes, Out of Scope
   and Verification. The Out of Scope section is binding.
2. **Extract the acceptance criteria** into a checklist you keep as you work.
3. **Inspect the repository before editing.** Find the layer the change belongs
   in, find the closest existing example, and read it.
4. **Follow existing conventions** over your own preferences: file layout,
   naming, error handling, test style, comment density.
5. **Make the smallest coherent change** that satisfies the criteria.
6. **Avoid unrelated improvements.** Spotted something else worth doing? Open an
   Issue for it. Do not fold it into this change.
7. **Add or update tests.** New behaviour needs a test that fails without it.
8. **Run the relevant verification** (§6).
9. **Review your own diff**, hunk by hunk, against §7.
10. **Re-check every acceptance criterion** against the code as it now stands,
    not against what you intended to write.
11. **Fix what you found.** Then re-run verification.
12. **Open a pull request** using the template, referencing the Issue.

Keep iterating until every acceptance criterion is satisfied, or until you hit a
genuine blocker (§2).

**Never report completion while a relevant test, typecheck or build is failing.**
If something is unfinished, say so explicitly in the PR — an honest gap is
useful; a gap described as done is not.

---

## 2. When to stop and ask

Stop, and report what you found, when:

- requirements in the Issue materially conflict with each other or with
  `docs/architecture.md`;
- credentials or access you need are unavailable;
- an external dependency makes required verification impossible;
- a significant architectural decision is required and no existing
  documentation establishes a direction;
- the requested change would violate an architectural invariant (§4).

Do **not** stop for ordinary implementation decisions. Naming, file placement,
whether to extract a helper, which of two equivalent shapes to use — inspect the
repository, pick the simplest option consistent with what is already there, and
move on.

---

## 3. Layout

```
apps/
  api/         Elysia + oRPC HTTP surface, application services, repositories
  worker/      Background job consumer (BullMQ)
  web/         User-facing TanStack Start application
  admin/       Administration TanStack Start application
packages/
  api-contract/  oRPC contract + Zod schemas. CLIENT-SAFE.
  api-client/    oRPC client + TanStack Query bindings. CLIENT-SAFE.
  ui/            Shared React components and stylesheet. BROWSER-ONLY.
  auth/          AuthProvider abstraction and the local provider. SERVER-ONLY.
  db/            Drizzle schema, migrations, connection pool. SERVER-ONLY.
  jobs/          Queue definitions, Redis connection, heartbeat. SERVER-ONLY.
  logger/        Structured logging and correlation ids. SERVER-ONLY.
  config/        Environment parsing helpers. Host-agnostic.
infra/
  docker/      One multi-stage Dockerfile, four runtime targets
  proxy/       nginx configuration (reverse proxy + load balancer)
e2e/           Playwright tests against the running Docker stack
docs/          Architecture, development, workflow, ADRs
```

---

## 4. Architectural invariants

These are not style preferences. A change that breaks one is wrong even if it
passes CI.

**Layering.** Requests flow:

```
web / admin / future mobile
  -> TanStack Query
  -> oRPC client            (packages/api-client)
  -> reverse proxy
  -> Elysia + oRPC handler  (apps/api/src/rpc)
  -> service                (apps/api/src/modules/<domain>/service.ts)
  -> repository             (apps/api/src/modules/<domain>/repository.ts)
  -> PostgreSQL
```

- Business logic lives in **services**. Not in React components, not in HTTP
  handlers, not in oRPC procedure bodies.
- oRPC handlers translate a call into a service call. If a handler grows a
  branch, that branch belongs in the service.
- SQL and Drizzle imports live in **repositories** and in `packages/db`. Nowhere
  else.
- Services receive their dependencies; they do not reach for globals.

**The API is the application API.** `apps/web` and `apps/admin` are clients of
it, exactly as a future Expo app will be. Do not make TanStack Start server
functions the primary API, and do not add an endpoint that only one client can
reach.

**Client-safe packages stay client-safe.** `packages/api-contract` and
`packages/api-client` are compiled into browser and React Native bundles. They
must never import a database driver, a server secret, a Node/Bun built-in, or
any `SERVER-ONLY` package. Tests in each package enforce the dependency
allowlist; if you need to relax one, that is an architectural decision (§2).

**Application user ids are ours.** `users.id` is generated by this application.
An authentication provider's subject id is stored in `user_identities`
(`provider`, `provider_user_id`) and is never used as a user id, foreign key, or
anything else outside that table. See `docs/adr/0004-authentication-abstraction.md`.

**Keep the API stateless.** Any request may be served by any API replica. No
in-memory sessions, no per-instance caches that affect correctness, no local
filesystem state. Anything shared goes in PostgreSQL or Redis.

**Every schema change is a migration.** Edit `packages/db/src/schema/`, then run
`bun run db:generate` and commit the generated SQL. Never hand-edit a generated
migration and never change one that has already been merged.

---

## 5. Conventions

- **TypeScript everywhere**, `strict`, no `any` (Biome enforces it). Prefer
  narrowing and explicit types over assertions.
- **Zod** for anything crossing a boundary: environment variables, contract
  inputs and outputs, job payloads.
- **Explicit over clever.** Speculative abstraction is worse than repetition.
- **Comments explain why**, not what. Match the surrounding density: most code
  here carries a short note on a non-obvious decision and nothing more.
- **Errors reaching a client are sanitised.** Internal messages, stack traces
  and connection strings stay in the logs.
- **Logging** goes through `@newsdeck/logger`. Use the request-scoped child
  logger from the oRPC context so records carry `requestId`. Never `console.log`
  in application code — Biome will reject it.
- **New dependencies need a concrete, stated reason.** Say it in the PR.

### Adding an oRPC procedure

1. Define input/output schemas and the procedure in `packages/api-contract`.
2. Implement it in `apps/api/src/modules/<domain>/router.ts`, delegating to a
   service.
3. Put the logic in `service.ts`, persistence in `repository.ts`.
4. Test the service directly, and the procedure through `buildServer(...)` with
   fake services (see `apps/api/test/server.test.ts`).
5. Consume it from a client with `orpc.<namespace>.<procedure>.queryOptions()`.

### Adding a background job

1. Define the job name and payload schema in `packages/jobs/src/definitions.ts`.
2. Add a handler in `apps/worker/src/handlers/` and register it in
   `apps/worker/src/index.ts`.
3. Payloads are validated against the definition before the handler runs — a
   queue outlives any single deploy, so never assume the payload is well formed.
4. In tests that touch Redis, pass a namespace unique to the suite. Otherwise a
   running worker, or a suite executing in parallel, will consume your jobs.

---

## 6. Verification

Run what your change touches, from the repository root:

```bash
bun run lint        # Biome: formatting, lint rules, import order
bun run typecheck   # tsc across every package and app
bun run test        # unit + integration (bun test)
bun run build       # production builds of web and admin
```

Integration tests **skip themselves** when `TEST_DATABASE_URL` and
`TEST_REDIS_URL` are unset. A green run with everything skipped is not a green
run. Start the services and export both — see
[`docs/development.md`](docs/development.md#testing).

For anything touching Docker, the proxy, SSR, or cross-service behaviour:

```bash
docker compose up -d --build --wait
bun run verify:lb   # proves the proxy distributes across API and web instances
bun run test:e2e    # Playwright, through the proxy
```

`apps/api` and `apps/worker` have no build step — Bun runs TypeScript directly,
so `bun run typecheck` is their compile-time gate.

---

## 7. Self-review checklist

Read your own diff before opening a PR and look specifically for:

- [ ] unnecessary complexity, or an abstraction with one caller
- [ ] a server-only import reaching a client-safe package
- [ ] business logic that leaked into a component or an HTTP handler
- [ ] secrets, tokens or real credentials committed
- [ ] a provider's user id used as an application user id
- [ ] state that breaks when a request lands on a different API replica
- [ ] a schema change without a generated migration
- [ ] duplicated configuration that should have one source
- [ ] behaviour added without a test
- [ ] dead code, unused exports, leftover debugging
- [ ] a placeholder described as finished
- [ ] an important decision left undocumented

---

## 8. Pull requests

Use `.github/pull_request_template.md`. Reference the Issue with `Closes #N`.

Map every acceptance criterion to the thing that satisfies it. If a box is
unchecked, explain why in the PR rather than leaving it blank.
