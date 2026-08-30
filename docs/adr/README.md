# Architecture decision records

One file per decision that would otherwise be re-litigated. Each records the
context at the time, the decision, and what it costs — not just what was chosen.

Add one when a decision is durable and non-obvious. Do not add one for a choice
the code already makes plain.

| ADR                                                        | Decision                                                |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| [0001](0001-bun-monorepo.md)                                | Bun workspaces plus Turborepo                            |
| [0002](0002-elysia-orpc-api.md)                             | ElysiaJS + oRPC as the application API                   |
| [0003](0003-postgres-drizzle-valkey-bullmq.md)              | PostgreSQL/Drizzle for state, Valkey/BullMQ for jobs     |
| [0004](0004-authentication-abstraction.md)                  | Provider-agnostic authentication, application-owned ids  |
| [0005](0005-nginx-explicit-instances.md)                    | nginx with explicitly listed instances                   |
| [0006](0006-typescript-version.md)                          | Pin TypeScript 5.9 rather than 7                         |
