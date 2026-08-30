# 0002 — ElysiaJS + oRPC as the application API

**Status:** accepted

## Context

The API must be consumable by the user web app, the admin app, and a future Expo
application, with end-to-end type safety and without a code-generation step.

TanStack Start offers server functions, which would be the path of least
resistance for the web app alone.

## Decision

The application API is an oRPC **contract-first** router served by Elysia and
mounted at `/rpc`.

`packages/api-contract` defines the contract with `oc` and Zod. The server
implements it with `implement(contract)`, so an unimplemented or mis-shaped
procedure is a compile error. Clients derive their types from the same package.

TanStack Start server functions are explicitly **not** the application API. They
are reachable only from the app that defines them, which would make the mobile
client a second-class consumer and push logic back into the presentation tier.

## Consequences

- One contract, three consumers, no generated clients to keep in sync.
- The contract package is client-safe by construction and tested to stay that
  way, so a React Native bundle can import it.
- Elysia contributes the HTTP surface — health, readiness, middleware, request
  correlation — while oRPC owns the application procedures. Each does one job.
- Cost: two libraries where a single framework would do, and one more hop for
  the web app's SSR (it calls the API over HTTP rather than in-process). That
  hop is the point: it is the same call a mobile client makes, so it cannot rot.
- Cost: procedures are POSTed to an RPC path rather than exposed as REST. If a
  public REST surface is ever needed, oRPC's OpenAPI handler can serve the same
  contract alongside the RPC one.
