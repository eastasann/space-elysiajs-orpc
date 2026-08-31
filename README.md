# Newsdeck

A news discovery and bookmarking platform, in the spirit of NewsPicks and
Hatena Bookmark.

> **Status: bootstrap.** The platform foundation is built and verified —
> monorepo, Docker development environment, database migrations, the API, both
> web applications, the background worker, the reverse proxy and its load
> balancing, CI, and structured logging with request correlation.
>
> The product features (article ingestion, feeds, categories, bookmarks, votes,
> comments, moderation, search) are **not implemented**. They are tracked as 34
> GitHub Issues in dependency order — see [`docs/roadmap.md`](docs/roadmap.md)
> for the backlog and
> [`docs/issue-driven-development.md`](docs/issue-driven-development.md) for how
> one is picked up.

---

## Architecture at a glance

```
                    Browser
                       │
              ┌────────▼────────┐
              │  nginx  :8080   │  user web + /api
              │         :8081   │  admin    + /api
              └───┬────┬────┬───┘
        ┌─────────┘    │    └──────────┐
   ┌────▼────┐    ┌────▼────┐    ┌─────▼─────┐
   │ web-1/2 │    │  admin  │    │ api-1 / 2 │
   │  (SSR)  │    │  (SSR)  │    │  Elysia   │
   └────┬────┘    └────┬────┘    │  + oRPC   │
        │              │         └──┬─────┬──┘
        └──── /api ────┴────────────┘     │
             (back through the proxy)     │
                                   ┌──────┴──────┐
                              ┌────▼────┐   ┌────▼────┐
                              │ Postgres│   │  Redis  │
                              └────▲────┘   └────▲────┘
                                   │             │
                                   │        ┌────┴────┐
                                   └────────│ worker  │
                                            └─────────┘
```

Within a request:

```
Web / Admin / future Mobile
  → TanStack Query
  → oRPC client
  → reverse proxy
  → Elysia + oRPC
  → application service
  → repository
  → PostgreSQL
```

The API is the application API. The web and admin apps are clients of it, as a
future Expo application will be. Full detail in
[`docs/architecture.md`](docs/architecture.md).

## Technology

| Concern            | Choice                                | Why                                                     |
| ------------------ | ------------------------------------- | ------------------------------------------------------- |
| Runtime, packages  | Bun 1.3, Bun workspaces               | Runs TypeScript directly; one tool for install and test |
| Task runner        | Turborepo                             | Caches typecheck and build across packages              |
| API                | ElysiaJS + oRPC                       | End-to-end types from one contract, no code generation  |
| Contracts          | oRPC contract-first + Zod             | One package shared by every client                      |
| Frontend           | React 19, TanStack Start/Router/Query | SSR with the routing and caching layers already joined  |
| Database           | PostgreSQL 17 + Drizzle ORM           | SQL-first schema with generated, reviewable migrations  |
| Cache and queue    | Valkey 8 + BullMQ                     | BSD-licensed Redis replacement; retries and scheduling  |
| Proxy              | nginx                                 | Explicit, inspectable load balancing                    |
| Lint and format    | Biome                                 | One fast tool instead of ESLint plus Prettier           |
| Tests              | `bun test`, Playwright                | Native runner for unit and integration; browser for E2E |

Decisions with lasting consequences are recorded in [`docs/adr/`](docs/adr/).

## Repository structure

```
apps/
  api/        Elysia + oRPC API. Services and repositories live here.
  worker/     Background job consumer.
  web/        User-facing TanStack Start application.
  admin/      Administration application.
packages/
  api-contract/  oRPC contract and Zod schemas.  Client-safe.
  api-client/    oRPC client + TanStack Query.   Client-safe.
  ui/            Shared React components + CSS.  Browser.
  auth/          AuthProvider abstraction.       Server.
  db/            Drizzle schema and migrations.  Server.
  jobs/          Queue and cache boundary.       Server.
  logger/        Structured logging.             Server.
  config/        Environment parsing.            Host-agnostic.
infra/
  docker/     One multi-stage Dockerfile, four runtime targets.
  proxy/      nginx reverse proxy and load balancer.
tooling/
  loop/       Decision logic for the autonomous issue-to-merge loop.
e2e/          Playwright tests against the running stack.
docs/         Architecture, development, workflow, ADRs.
```

## Prerequisites

- **Docker** with Compose v2 — the only requirement for running the stack.
- **Bun 1.3+** — for tests, linting and the helper scripts. Install from
  <https://bun.sh>.

You do not need PostgreSQL, Valkey/Redis, nginx or Node.js on your machine.

## Running it

```bash
docker compose up -d --build --wait
```

Then open:

| URL                     | What                                            |
| ----------------------- | ----------------------------------------------- |
| <http://localhost:8080> | User web application                            |
| <http://localhost:8081> | Admin application                               |
| <http://localhost:8080/api/health> | API liveness — names the replica     |

Migrations run automatically: a one-shot `migrate` service applies them and must
succeed before any API instance starts.

**Ports published to the host: 8080 and 8081, on the loopback interface, and
nothing else.** PostgreSQL, Valkey, the API instances, the worker and the SSR
servers are reachable only inside the Compose networks. To publish them for
host-side development, layer in the opt-in overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-ports.yml up -d
```

### Shutting down

```bash
docker compose down                  # stop, keep data
docker compose down --volumes        # stop and discard PostgreSQL and Valkey data
```

### Resetting local state

```bash
bun run docker:reset                 # down --volumes --remove-orphans
docker compose up -d --build --wait  # rebuild from scratch
```

## Common commands

```bash
bun install            # install workspace dependencies

bun run dev            # run every app on the host (Vite + Bun watch)
bun run build          # production builds of web and admin
bun run lint           # Biome: format check, lint, import order
bun run lint:fix       # apply what Biome can fix
bun run typecheck      # tsc across every package and app
bun run test           # unit and integration tests
bun run test:e2e       # Playwright against the running stack

bun run db:generate    # generate a migration from the Drizzle schema
bun run db:migrate     # apply pending migrations

bun run docker:up      # docker compose up -d --build
bun run docker:down    # docker compose down
bun run docker:reset   # down --volumes --remove-orphans
bun run docker:logs    # follow all container logs
bun run verify:lb      # prove the proxy is distributing requests
```

## Testing

Unit tests run anywhere. Integration tests need real PostgreSQL and Valkey and
**skip themselves** when `TEST_DATABASE_URL` and `TEST_REDIS_URL` are unset — so
a fully green run with everything skipped is not a green run. See
[`docs/development.md`](docs/development.md#testing) for how to point them at
the containers.

End-to-end tests drive a browser through the reverse proxy against the running
Docker stack, so start it first.

## Verifying load balancing

```bash
bun run verify:lb
```

Samples both pools and reports which instance answered, using two independent
signals: nginx's `X-Upstream-Addr` header and the `instanceId` the API reports
in its own response body. Exits non-zero if either pool answered from a single
instance. See [`docs/architecture.md`](docs/architecture.md#load-balancing).

## Fully unattended development

Issues labelled `agent:ready` are implemented, verified, reviewed and merged
without a person in the middle, by Claude Code running on your own machine with
your own subscription login. No Anthropic API key is needed.

Prerequisites: [Claude Code](https://code.claude.com) (logged in),
[GitHub CLI](https://cli.github.com) (`gh auth login`), Bun, Docker.

```bash
bun run loop:status                     # mode, phase, backlog, blockers
bun run loop:once --dry-run             # the plan; changes nothing
bun run loop:watch --unattended         # the normal operating mode
```

Risk decides how much verification a change must pass, not whether a human is
summoned. A documentation fix runs lint, types, tests and a build; a change to
`packages/auth` additionally runs end-to-end tests, a Docker smoke test and
**two independent reviews**. All three tiers merge on their own.

The runner works in an isolated worktree and has no authority to merge: it
enables GitHub's own auto-merge and GitHub's required checks decide. A blocked
issue never stops the backlog — the loop marks it and moves to independent work.

See [`docs/local-agent-runner.md`](docs/local-agent-runner.md).

## Contributing

Work is organised as GitHub Issues, one independently reviewable change at a
time. Read [`AGENTS.md`](AGENTS.md) — it applies to humans too — then
[`docs/issue-driven-development.md`](docs/issue-driven-development.md), and pick
the first unblocked Issue from [`docs/roadmap.md`](docs/roadmap.md).

Issues labelled `agent:ready` are worked by an autonomous loop: a coding agent
implements them, an automated review and a deterministic risk gate decide whether
the result may merge, and anything touching security, infrastructure or
architecture waits for a human. See
[`docs/loop-engineering.md`](docs/loop-engineering.md) for the GitHub side and
[`docs/local-agent-runner.md`](docs/local-agent-runner.md) for the runner that
executes it locally.
