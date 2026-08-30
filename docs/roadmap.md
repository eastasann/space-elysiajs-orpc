# Roadmap

The backlog as GitHub Issues, in dependency order. Each is one independently
reviewable change with its own acceptance criteria and out-of-scope section —
see [`issue-driven-development.md`](issue-driven-development.md).

Work top to bottom. An Issue names what it depends on; do not start one whose
dependencies are open.

## Milestone 0 — Platform foundation

Built and verified in the bootstrap: the monorepo, the Docker development
environment, database migrations, the API, oRPC integration, both web
applications, the reverse proxy and its load balancing, CI, and structured
logging with request correlation.

What remains are the gaps the bootstrap left open, each stated honestly rather
than left implied:

| # | Issue | Depends on |
| - | ----- | ---------- |
| [#1](../../issues/1) | Add a hot-reload Docker development profile | — |
| [#2](../../issues/2) | Add component tests for the web and admin applications | — |
| [#3](../../issues/3) | Evaluate upgrading TypeScript from 5.9 to 7 | — |

These three are independent of each other and of everything below.

## Milestone 1 — News ingestion

Feeds in, articles out, visible to users and operators.

| # | Issue | Depends on |
| - | ----- | ---------- |
| [#4](../../issues/4) | Add the `sources` table and migration | — |
| [#5](../../issues/5) | Add the source repository and service | #4 |
| [#6](../../issues/6) | Expose sources through the oRPC contract | #5 |
| [#7](../../issues/7) | Add source management to the admin application | #6 |
| [#8](../../issues/8) | Add the `categories` table and migration | — |
| [#9](../../issues/9) | Add the `articles` table and migration | #4, #8 |
| [#10](../../issues/10) | Fetch feeds in a background job | #4 |
| [#11](../../issues/11) | Parse and normalise feed entries | #10 |
| [#12](../../issues/12) | Deduplicate article candidates before persistence | #9, #11 |
| [#13](../../issues/13) | Wire the ingestion pipeline and record collector runs | #10, #11, #12 |
| [#14](../../issues/14) | Expose articles through the oRPC contract | #13 |
| [#15](../../issues/15) | Show the latest articles in the user web application | #14 |
| [#16](../../issues/16) | Add article and collector views to the admin application | #13, #14 |

## Milestone 2 — Identity

Turning the authentication abstraction into working authentication.

| # | Issue | Depends on |
| - | ----- | ---------- |
| [#17](../../issues/17) | Add the user repository and service | — |
| [#18](../../issues/18) | Resolve an `AuthIdentity` to an application user | #17 |
| [#19](../../issues/19) | Add a local development sign-in endpoint | #18 |
| [#20](../../issues/20) | Add authenticated oRPC procedures | #18, #19 |
| [#21](../../issues/21) | Add an authorization foundation | #20 |
| [#22](../../issues/22) | Add an external OIDC provider adapter as a proof of concept | #20 |
| [#23](../../issues/23) | Add the user profile API and page | #20 |

## Milestone 3 — Engagement

What makes it a discovery platform rather than a reader.

| # | Issue | Depends on |
| - | ----- | ---------- |
| [#24](../../issues/24) | Add bookmarks | #15, #23 |
| [#25](../../issues/25) | Add votes and reactions | #24 |
| [#26](../../issues/26) | Add comments on articles | #25 |
| [#27](../../issues/27) | Add comment moderation | #26, #21 |
| [#28](../../issues/28) | Add article ranking | #25, #26 |
| [#29](../../issues/29) | Add a trending articles view | #28 |

## Milestone 4 — Mobile readiness

Testing the claims the architecture makes about a future Expo application,
rather than restating them.

| # | Issue | Depends on |
| - | ----- | ---------- |
| [#30](../../issues/30) | Enforce the client-safe package boundary in CI | — |
| [#31](../../issues/31) | Verify the authentication abstraction supports a mobile client | #22 |
| [#32](../../issues/32) | Prove the API client works under Expo and React Native | #30, #31 |
| [#33](../../issues/33) | Design the deep-link architecture | #32 |
| [#34](../../issues/34) | Design the push-notification architecture | #33 |

---

## Not yet scheduled

Named here so they are not mistaken for oversights. Each needs an Issue before
it is worked on:

- **Search** over articles — needs a decision on PostgreSQL full-text versus a
  dedicated index, and belongs after Milestone 1 has produced enough articles to
  judge.
- **Personalised feeds** — depends on engagement signals from Milestone 3.
- **`robots.txt` handling** in the collector.
- **Rate limiting** on votes and comments.
- **Metrics and tracing** — `docs/architecture.md#observability` explains why the
  bootstrap stops at correlation ids.
- **Configurable CORS for non-proxied clients** beyond the host-mode case.
- **Audit logging** of privileged admin actions.
