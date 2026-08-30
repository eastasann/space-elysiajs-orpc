# 0005 — nginx with explicitly listed instances

**Status:** accepted

## Context

The environment must demonstrate real load balancing across multiple API
instances, and ideally multiple web instances, in a way that can be verified
rather than assumed.

Docker Compose can scale a service with `deploy.replicas`, and the service name
then resolves to several addresses.

## Decision

nginx, with each instance listed **explicitly** in its upstream block:

```nginx
upstream newsdeck_api {
  server api-1:3001 max_fails=3 fail_timeout=10s;
  server api-2:3001 max_fails=3 fail_timeout=10s;
  keepalive 32;
}
```

Compose defines `api-1`/`api-2` and `web-1`/`web-2` as distinct services sharing
a YAML anchor, rather than replicas of one service.

nginx resolves a hostname **once, at start-up**. A single service name with
several replicas would therefore pin every request to whichever address it
happened to resolve — the configuration would look load balanced and would not
be. Listing instances explicitly is what makes round robin real, and it is why
`proxy` waits for every application service to be healthy before starting.

Admin is served on its own port (`8081`) rather than under a path prefix, so
neither frontend needs a router basepath and the admin surface can later be
restricted at the network edge without touching application code.

## Consequences

- Round robin is observable, and `bun run verify:lb` checks it from two
  independent angles: nginx's `X-Upstream-Addr` and the `instanceId` the API
  reports in its own body.
- `proxy_next_upstream` makes the loss of one replica invisible to callers.
- SSR calls the API back through the proxy, so server-rendered pages are load
  balanced too and no API replica becomes the SSR tier's private backend.
- Cost: adding a third instance means editing both `docker-compose.yml` and
  `nginx.conf`. That is acceptable for a development topology, and it is honest
  — the alternative hides a configuration that does not work.
- Cost: `/api/` responses are buffered while `/` responses are not, because
  TanStack Start streams SSR output. Two settings instead of one, for a real
  reason.
