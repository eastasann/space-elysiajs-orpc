# Development

- [Two ways to run it](#two-ways-to-run-it)
- [Docker workflow](#docker-workflow)
- [Host-mode workflow](#host-mode-workflow)
- [Migrations](#migrations)
- [Testing](#testing)
- [Logs](#logs)
- [Debugging](#debugging)
- [Adding things](#adding-things)

---

## Two ways to run it

**Docker** is the reference environment. It is what CI runs, what the E2E tests
target, and the only way to exercise the proxy, load balancing and SSR-through-
the-proxy. Reach for it by default.

**Host mode** (`bun run dev`) is for tight iteration on a single application.
It gives you Vite HMR and Bun's watch mode, but no proxy and no second instance
of anything.

---

## Docker workflow

```bash
docker compose up -d --build --wait   # --wait blocks until every health check passes
docker compose ps                     # health of each service
docker compose logs -f api-1          # follow one service
docker compose down                   # stop, keep data
bun run docker:reset                  # stop and discard all volumes
```

| URL                                  | What                              |
| ------------------------------------ | --------------------------------- |
| <http://localhost:8080>              | User web application              |
| <http://localhost:8081>              | Admin application                 |
| <http://localhost:8080/api/health>   | API liveness; names the replica   |
| <http://localhost:8080/api/ready>    | API readiness; 503 when degraded  |
| <http://localhost:8080/healthz>      | Proxy liveness                    |

Only 8080 and 8081 are published, on the loopback interface. Set
`PROXY_BIND=0.0.0.0` to reach the stack from another machine.

### Rebuilding after a change

```bash
docker compose up -d --build api-1 api-2      # after an API change
docker compose up -d --build web-1 web-2      # after a web change
```

Only the manifests are copied before `bun install` in the Dockerfile, so editing
application code costs a source copy, not a reinstall.

### Behind a TLS-intercepting proxy

Corporate proxies and some CI egress gateways re-terminate TLS, which can make
`bun install` fail during the image build with certificate errors. Two knobs:

```bash
# Reduce concurrent connections
docker compose build --build-arg BUN_NETWORK_CONCURRENCY=8
```

If the interceptor uses a private CA, the base image must trust it — build a
local `oven/bun:1.3-alpine` that adds your CA to `/etc/ssl/certs` and sets
`NODE_EXTRA_CA_CERTS`, and point the build at it with
`--build-context oven/bun:1.3-alpine=docker-image://<your-image>`.

### Reaching PostgreSQL and Valkey

They are not published by default. Either go through the container:

```bash
docker compose exec postgres psql -U newsdeck -d newsdeck
docker compose exec redis valkey-cli
```

…or layer in the opt-in overlay, which publishes 5432, 6379 and the API on 3001:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-ports.yml up -d
```

---

## Host-mode workflow

Start infrastructure in Docker, applications on the host:

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev-ports.yml up -d postgres redis
bun install
bun run db:migrate
bun run dev
```

| Service | Port   | Notes                                                     |
| ------- | ------ | --------------------------------------------------------- |
| web     | `3000` | Vite dev server; proxies `/api` to `localhost:3001`        |
| admin   | `3000` | Set `ADMIN_PORT` to move it — run one at a time by default |
| api     | `3001` | `bun --watch`                                              |
| worker  | `3002` | `bun --watch`                                              |

The Vite dev server proxies `/api` so the browser's code path is identical to
production: it always calls a same-origin `/api/...`, and something in front
forwards it. Point it elsewhere with `DEV_API_PROXY_TARGET`.

Host mode is the reason the API supports CORS at all (`API_CORS_ORIGINS`);
through the proxy everything is same-origin.

---

## Migrations

Never hand-write a migration, and never edit one that has been merged.

```bash
# 1. Edit packages/db/src/schema/*.ts
# 2. Generate SQL from the schema diff
bun run db:generate
# 3. Read packages/db/drizzle/NNNN_*.sql before committing it
# 4. Apply
bun run db:migrate
```

In Docker, a one-shot `migrate` service applies migrations and must exit
successfully before any API instance starts, so no replica serves traffic
against an older schema. Drizzle takes a Postgres advisory lock, so concurrent
runs from several replicas are safe.

`bun run db:migrate` on the host reads `DATABASE_URL` from your environment.

---

## Testing

```bash
bun run test        # unit + integration
bun run test:e2e    # Playwright, against the running Docker stack
```

Turborepo caches `typecheck` and `build`, which are pure functions of the source
tree. `test` is deliberately **not** cached: integration tests talk to live
PostgreSQL and Valkey, so a cached pass could report success for a run that
never happened.

### Integration tests skip themselves

Suites named `*.integration.test.ts` need real services and are skipped when
their URLs are unset. **A green run with everything skipped is not a green run.**
Give them services:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-ports.yml up -d postgres redis
docker compose exec postgres psql -U newsdeck -d newsdeck -c 'CREATE DATABASE newsdeck_test'

export TEST_DATABASE_URL='postgres://newsdeck:newsdeck_local_password@localhost:5432/newsdeck_test'
export TEST_REDIS_URL='redis://localhost:6379'
bun run test
```

CI always provides both, and asserts they are set.

### What lives where

| Kind        | Where                                             | Needs                        |
| ----------- | ------------------------------------------------- | ---------------------------- |
| Unit        | `packages/*/test`, `apps/*/test`                  | nothing                      |
| Integration | `*.integration.test.ts`                           | PostgreSQL and/or Valkey     |
| E2E         | `e2e/tests`                                       | the running Docker stack     |

`apps/api/test/server.test.ts` builds the real Elysia server over **fake
services** and drives it with `app.handle(request)` — full transport coverage,
no infrastructure. `apps/api/test/rpc.integration.test.ts` does the opposite: a
real oRPC client over a real server over real PostgreSQL and Valkey.

Every suite that touches Redis passes its own **jobs namespace**, so it owns its
queue and heartbeat outright. Without that, the compose worker — or the suite
Turborepo is running in parallel — would consume its jobs, and the assertions
would be racing something they cannot see. Point `TEST_REDIS_URL` at the same
Valkey the stack uses; the namespace is what keeps them apart.

### End-to-end

```bash
docker compose up -d --build --wait
bun run test:e2e
```

Nothing is started for you: the tests assert on real container behaviour,
including which API replica answered, so an in-process server would defeat their
purpose. If your machine already has browsers provisioned, point Playwright at
one with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium`; otherwise run
`bunx playwright install chromium`.

---

## Logs

Every process writes newline-delimited JSON to stdout. Pipe it through `jq`:

```bash
docker compose logs -f api-1 | jq -c '{t:.time, id:.requestId, path, status, ms:.durationMs}'
docker compose logs worker   | jq -c 'select(.level=="error")'
```

Follow one request across every hop by its correlation id:

```bash
curl -H 'x-request-id: req-my-trace-1' http://localhost:8080/
docker compose logs --no-log-prefix | grep req-my-trace-1
```

Raise verbosity with `LOG_LEVEL=debug` in `.env`, then recreate the services.

---

## Debugging

**A service will not start.** `docker compose ps` shows health;
`docker compose logs <service>` shows why. Configuration errors are explicit —
`EnvironmentError` names every failing variable (and never prints its value).

**The web app renders an error panel.** The message is the SSR failure. Check
that `api-1`/`api-2` are healthy, then confirm `SERVER_API_URL` resolves inside
the network — it must include the proxy's container port
(`http://proxy:8080/api`), not the host mapping.

**Requests all land on one instance.** Run `bun run verify:lb`. If one pool has
a single upstream, check that both instances are healthy — nginx takes a peer
out of rotation after repeated failures.

**A job is not running.** `system.status` reports queue depth and the worker
heartbeat; the admin dashboard shows both. A non-zero `failed` count means jobs
reached BullMQ's failed set — inspect them with `docker compose exec redis
valkey-cli`, or read the worker log, which records the failure reason.

**A test passes locally and fails in CI.** The most common cause is an
integration test that skipped locally. Check `TEST_DATABASE_URL` and
`TEST_REDIS_URL`.

---

## Adding things

### A dependency

Add it to the package that uses it, not the root. Bun's isolated node_modules
layout means a package can only import what it declares — an undeclared import
fails at typecheck rather than working by accident through hoisting.

Client-safe packages (`api-contract`, `api-client`, `ui`) have tests asserting
their dependency allowlist. Adding one there is an architectural decision.

### An oRPC procedure

See [`AGENTS.md`](../AGENTS.md#adding-an-orpc-procedure).

### A background job

See [`AGENTS.md`](../AGENTS.md#adding-a-background-job).

### A route

Create the file under `apps/<app>/src/routes/`. The TanStack Start plugin
regenerates `routeTree.gen.ts` on the next dev run or build. That file is
**committed** so that `bun run typecheck` works without a build first — CI fails
if a build would change it, so commit the regenerated version with your change.
