# Architecture

How the system is put together, and which boundaries are load-bearing.

- [System boundaries](#system-boundaries)
- [Request flow](#request-flow)
- [Applications](#applications)
- [Packages](#packages)
- [Database](#database)
- [Background worker](#background-worker)
- [Reverse proxy and load balancing](#load-balancing)
- [Authentication](#authentication)
- [Observability](#observability)
- [Future Expo application](#future-expo-application)

---

## System boundaries

Seven processes, each with a reason to be separate:

| Process       | Boundary it draws                                                  |
| ------------- | ------------------------------------------------------------------ |
| `proxy`       | The only thing on the host network. Terminates and distributes.     |
| `web-1/2`     | Renders the user-facing UI. Holds no domain logic.                  |
| `admin`       | Renders the operations UI. Same shape as `web`, different audience. |
| `api-1/2`     | Owns the application API, its services and its persistence.         |
| `worker`      | Runs work that must not compete with user requests for capacity.    |
| `postgres`    | Durable state.                                                      |
| `redis`       | Ephemeral state: the job queue and the worker heartbeat.             |

There are no other processes. The split is by concrete boundary — request
serving, background processing, storage — not by domain. There is no
article-service or user-service, and adding one would be a regression.

Two Docker networks enforce the split:

- **`edge`** — `proxy`, `web-1`, `web-2`, `admin`, `api-1`, `api-2`
- **`backend`** — `api-1`, `api-2`, `worker`, `postgres`, `redis`

The API instances sit on both; they are the only path from a request to the
database. The proxy is not on `backend` and cannot resolve `postgres` at all:

```console
$ docker compose exec proxy sh -c 'nc -z postgres 5432'
nc: bad address 'postgres'
$ docker compose exec api-1 sh -c 'nc -z postgres 5432 && echo reachable'
reachable
```

---

## Request flow

```
Browser
  │  GET / (:8080)
  ▼
nginx ──────────────────────────► web-1 or web-2   (round robin)
                                    │  TanStack Start route loader
                                    │  TanStack Query → oRPC client
                                    ▼
nginx ◄─────────────────────────────┘  POST /api/rpc/system/status
  │
  ▼
api-1 or api-2   (round robin)
  │  Elysia route  /rpc/*
  │  oRPC handler → procedure
  ▼
service (apps/api/src/modules/<domain>/service.ts)
  ▼
repository (…/repository.ts)
  ▼
PostgreSQL
```

Two properties are deliberate:

**SSR goes back out through the proxy.** `SERVER_API_URL=http://proxy:8080/api`,
not a single API container. Server-rendered pages are therefore load balanced
exactly like browser requests, and one API replica cannot become the SSR tier's
private backend.

**The browser calls a same-origin path.** The client bundle builds its base URL
from `window.location.origin` at runtime; no API host is compiled into it. One
built image runs in any environment. In host-mode development the Vite dev
server proxies `/api` to `http://localhost:3001`, so the code path is identical.

### Layering rules

- Business logic lives in **services**.
- oRPC handlers translate a call into a service call — nothing else.
- SQL and Drizzle imports live in **repositories** and `packages/db`.
- React components render; they do not decide.

`apps/api/src/modules/system/` is the reference example of the shape. Its
repository is thin because the status endpoint reads little — future modules
will have real queries in the same place.

---

## Applications

### `apps/api`

Elysia serves three things:

| Route      | Purpose                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `/health`  | Liveness. Process state only — never touches PostgreSQL or Redis, so a dependency outage cannot cause healthy replicas to be killed. Reports `instanceId`. |
| `/ready`   | Readiness. Probes the dependencies this replica needs; 503 when they fail. |
| `/rpc/*`   | The application API, an oRPC `RPCHandler` mounted on the Elysia route.     |

Per-request context is built at the transport edge and handed to procedures:

```ts
interface RequestContext {
  requestId: string          // correlation id, in and out via x-request-id
  logger: Logger             // child logger already bound to requestId
  identity: AuthIdentity | null
  services: AppServices
}
```

No database handle, no Redis client, no raw request. Procedures talk to
services; services own infrastructure.

### `apps/worker`

A BullMQ consumer plus a small liveness endpoint on `:3002`. It holds two Redis
connections: BullMQ's consumer connection blocks, and sharing it with the
producer would stall queue writes behind a blocking read.

### `apps/web` and `apps/admin`

TanStack Start applications. Data is fetched in a route `loader` via
`queryClient.ensureQueryData(orpc.<procedure>.queryOptions())`, so the first
paint carries data and the browser does not refetch it. A fresh `QueryClient` is
created per request on the server — sharing one would leak one visitor's data
into another's SSR output.

`apps/admin` also carries the load-balancing probe: it calls the API from the
browser and groups answers by `instanceId`.

---

## Packages

| Package                  | Safe in a browser or React Native bundle? | Contents                              |
| ------------------------ | ----------------------------------------- | ------------------------------------- |
| `@newsdeck/api-contract` | **Yes**                                   | oRPC contract, Zod schemas            |
| `@newsdeck/api-client`   | **Yes**                                   | oRPC client, TanStack Query bindings  |
| `@newsdeck/ui`           | Browser only (DOM components)             | React components, stylesheet          |
| `@newsdeck/config`       | Host-agnostic                             | Zod environment parsing               |
| `@newsdeck/logger`       | **No**                                    | pino, correlation ids                 |
| `@newsdeck/db`           | **No**                                    | Drizzle schema, migrations, pool      |
| `@newsdeck/auth`         | **No**                                    | AuthProvider abstraction, local JWT   |
| `@newsdeck/jobs`         | **No**                                    | Queue definitions, Redis, heartbeat   |

The client-safe boundary is enforced by tests, not convention:
`packages/api-contract/test/boundary.test.ts` asserts a dependency allowlist and
scans every source file for forbidden import specifiers;
`packages/api-client/test/client.test.ts` does the same for its own manifest.

`@newsdeck/api-client` deliberately re-declares the `x-request-id` header name
rather than importing it from `@newsdeck/logger`, which would drag pino into
browser bundles. A test asserts the two definitions stay identical.

`@newsdeck/jobs` owns every reference to the queue implementation: it
constructs both the queue and the worker, and exposes `JobQueue`, `JobWorker`,
`QueuedJob` and `RedisConnection` aliases, so no application names `bullmq` or
`ioredis` directly.

Every Redis key it owns — BullMQ's queue keys and the worker heartbeat — is
prefixed with a **namespace**, defaulting to `newsdeck`. A producer and a
consumer only meet if their namespaces match. That is what lets several
deployments, or several concurrent test suites, share one Redis without
consuming each other's jobs.

---

## Database

PostgreSQL 17, accessed through Drizzle ORM over `postgres.js`.

The bootstrap schema is deliberately small — only what the authentication
architecture requires. `sources`, `categories`, `articles`, `bookmarks`,
`votes`, `comments` and `collector_runs` arrive with the Issues that use them.

```
users                        user_identities
─────                        ───────────────
id            uuid  PK  ◄──┐ id               uuid  PK
email         text  UQ     └─ user_id         uuid  FK  ON DELETE CASCADE
display_name  text            provider        text  ┐
created_at    timestamptz     provider_user_id text ┴ UNIQUE together
updated_at    timestamptz     created_at      timestamptz
                              last_seen_at    timestamptz
```

`users.id` is generated by this application. See
[Authentication](#authentication).

**Migrations.** Edit `packages/db/src/schema/`, run `bun run db:generate`,
review and commit the generated SQL. A one-shot `migrate` service applies them
before any API instance starts, so no replica ever serves traffic against an
older schema. Drizzle takes a Postgres advisory lock while migrating, so running
it from several replicas concurrently is safe.

---

## Background worker

The eventual ingestion pipeline is:

```
Feed source → Fetch → Parse → Normalise → Deduplicate → Persist → Categorise → Ranking
```

None of it is implemented. What exists is the boundary it will be built on:

- **Job definitions** (`packages/jobs/src/definitions.ts`) pair a job name with
  a Zod payload schema. The definition is the contract between the producer
  (usually the API) and the consumer.
- **Payload validation** happens before a handler runs. A queue outlives any
  single deploy, so a worker can receive a job an older producer enqueued.
- **Failures stay visible.** An unknown job name or an invalid payload moves the
  job to BullMQ's failed set rather than being dropped.
- **Correlation ids travel on the payload**, so one browser request can be
  followed into the background work it caused.
- **Keys are namespaced**, so a test suite or a second deployment sharing the
  Redis instance cannot consume jobs that are not its own.

The one job that exists, `system.heartbeat`, runs on a repeating schedule and
publishes worker liveness to Redis with a TTL. The API reports it through
`system.status`, which is how a stopped worker becomes visible. It exists to
prove the round trip end to end, and as the shape every ingestion handler
copies.

---

## Load balancing

nginx listens on two ports in one container:

| Port   | `/`                            | `/api/`                     |
| ------ | ------------------------------ | --------------------------- |
| `8080` | `web-1`, `web-2` (round robin) | `api-1`, `api-2` (round robin) |
| `8081` | `admin`                        | `api-1`, `api-2` (round robin) |

Admin is served on its own port rather than under a path prefix: neither app
then needs a router basepath, and the admin surface can later be restricted at
the network edge without touching application code.

Instances are listed **explicitly** in each upstream block. nginx resolves a
hostname once at start-up, so a single service name with several replicas would
pin every request to whichever address it happened to resolve. That is also why
`proxy` depends on every application service being healthy before it starts.

`proxy_next_upstream` retries the next instance on a connection error or 5xx, so
losing one replica is invisible to the caller:

```console
$ docker compose stop api-1
$ for i in $(seq 12); do curl -s localhost:8080/api/health | jq -r .instanceId; done
api-2   (×12, zero failures)
```

`/api/` responses are buffered; `/` responses are not, because TanStack Start
streams its SSR output and buffering would destroy time-to-first-byte.

### Verifying it

```console
$ bun run verify:lb
API pool (browser -> proxy -> API)
  by nginx upstream
    172.19.0.5:3001              10
    172.19.0.6:3001              10
  by API-reported instanceId
    api-1                        10
    api-2                        10

Web pool (browser -> proxy -> SSR server)
  by nginx upstream
    172.19.0.3:3000              10
    172.19.0.4:3000              10

OK: both pools distributed requests across multiple instances.
```

Two independent signals are collected: `X-Upstream-Addr`, added by nginx, names
the socket it chose; `instanceId` in the API's own body names the replica that
ran the handler. Agreement between a proxy-reported and an application-reported
identity is much stronger evidence than either alone.

**Statelessness is what makes this safe.** Any request may land on any replica,
so the API keeps no in-memory sessions and no per-instance caches that affect
correctness. Authentication is stateless for the same reason (below).

---

## Authentication

The application must be able to use Clerk, Auth0, Firebase, Cognito or any
OIDC/JWT provider — without any of them leaking into the domain, and without
needing one to run locally.

### The abstraction

```ts
interface AuthIdentity {
  provider: string          // 'local', matching user_identities.provider
  providerUserId: string    // the provider's opaque subject
  email: string | null
  displayName: string | null
}

interface AuthProvider {
  readonly name: string
  verifyToken(token: string): Promise<AuthIdentity | null>
}
```

Two absences are the point:

- **No application user id.** Mapping an identity to a `users.id` is a
  persistence concern, not something a provider may dictate.
- **No raw provider claims.** Letting them through would spread provider-specific
  vocabulary across the domain.

`verifyToken` returns `null` for any credential that is absent, malformed,
expired or addressed elsewhere — the caller cannot distinguish those cases and
should not. Throwing is reserved for provider outages, so a misconfigured
provider never quietly reads as "everyone is anonymous".

`createAuthProvider(env)` in `packages/auth/src/factory.ts` is the only place
that knows which concrete adapters exist. Adding a hosted provider means writing
an adapter and extending an enum; the exhaustiveness guard turns a missing
adapter into a compile error.

### Local development

`AUTH_PROVIDER=local` verifies JWTs this repository signs itself, so the whole
stack runs with no account anywhere. The algorithm is pinned to HS256, and
issuer and audience are both checked — `packages/auth/test/local-provider.test.ts`
covers wrong key, expiry, wrong issuer, wrong audience, `alg: none`, and a
missing or blank subject.

`issueLocalToken()` mints a token the local provider accepts. It is for
development and tests only; production obtains tokens from a real provider.

### What is wired up today

The API resolves an identity for every RPC request and puts it in the context.
It is **not yet used**: no procedure requires a caller, and nothing maps an
identity to a `users` row. That mapping, protected procedures and authorization
are Milestone 2 Issues. The `users` / `user_identities` schema and the provider
abstraction exist so that work is additive.

Verification is stateless — no server-side session is consulted — which is what
allows any API replica to serve any request.

---

## Observability

Every process emits newline-delimited JSON on stdout, carrying `service` and
`instanceId`:

```json
{"level":"info","time":"…","service":"api","instanceId":"api-2","requestId":"…","method":"POST","path":"/rpc/system/status","status":200,"durationMs":3,"msg":"request completed"}
{"level":"info","time":"…","service":"worker","instanceId":"worker-1","jobId":"…","jobName":"system.heartbeat","durationMs":0,"msg":"job completed"}
{"service":"proxy","time":"…","requestId":"…","method":"POST","path":"/api/rpc/system/status","status":200,"upstream":"172.19.0.6:3001","durationMs":0.005}
```

`instanceId` is on every record because behind a load balancer, "which one" is
the first question.

**Correlation ids** travel as `x-request-id`. nginx adopts a caller's id or mints
one; the API validates any inbound id before trusting it — the value ends up in
logs and downstream headers, so an unbounded or control-character-bearing value
from the public internet is replaced rather than echoed. The API echoes the id on
the response and includes it in `system.status`, so a user can quote it in a bug
report. `createIsomorphicFn` lets the SSR tier reuse the browser's id without
pulling server-only code into the client bundle:

```console
$ curl -H 'x-request-id: req-trace-1' localhost:8080/ | grep -o 'req-trace-1'
req-trace-1                                   # rendered by web, obtained from the API
$ docker compose logs api-1 | grep req-trace-1
{"…","service":"api","requestId":"req-trace-1","path":"/rpc/system/status","status":200}
```

Credential-bearing fields (`authorization`, `cookie`, `*.password`, `*.token`)
are redacted by the logger. Errors returned to clients are sanitised: internal
messages, stack traces and connection strings stay in the logs.

This is deliberately small. Metrics and tracing are worth adding when there is
something to measure; the correlation id is the hook they will attach to.

---

## Future Expo application

`apps/mobile` can be added without changing the backend. What makes that true:

- **`@newsdeck/api-contract` and `@newsdeck/api-client` are client-safe** and
  tested to stay that way. A React Native bundle can import both.
- **`createApiClient({ baseUrl, requestId, headers })`** takes its base URL and
  headers from the caller, because how you reach the API differs per host —
  same-origin in a browser, an absolute URL on a device.
- **`@newsdeck/ui` is not shared with mobile.** Its primitives are DOM-based.
  Mobile shares the contract and the client, not the components.
- **The API is transport-agnostic and stateless.** It has no browser-specific
  assumptions and no session affinity.
- **Authentication is provider-pluggable.** A device obtains a token from
  whichever provider is configured and sends it as a bearer token; the API
  verifies it through the same `AuthProvider` interface.

Milestone 4 Issues verify these properties rather than assuming them.
