# Issue-driven development

Work here moves one Issue at a time. An Issue is a unit of work that can be
implemented, verified and reviewed on its own — not a wish, and not a project.

```
Issue
  → repository investigation
  → implementation plan
  → implementation
  → tests
  → verification
  → self review
  → pull request
  → review
  → merge
```

[`AGENTS.md`](../AGENTS.md) is the operating manual for each step. This document
explains how the Issues themselves are shaped.

---

## What makes a good Issue

An Issue is well scoped when:

- it produces **one reviewable change** — a reviewer can hold all of it in their
  head at once;
- its **acceptance criteria are observable** — a reviewer can check each one
  without asking what the author intended;
- it says what is **out of scope**, so neither implementer nor reviewer has to
  guess where the edge is;
- it names its **dependencies**, so it can be picked up in order;
- it specifies **behaviour and constraints** more strongly than implementation.

Prefer a **vertical slice** — schema, API, UI for one small capability — over a
horizontal layer. A slice can be demonstrated; a layer can only be asserted.
Foundational Issues that cross no feature (the proxy, CI, the queue) are the
exception, and they come first.

### Well scoped

> **Add the `sources` table and its migration**
>
> Acceptance criteria:
> - [ ] `sources` exists with `id`, `name`, `feed_url`, `is_active`, timestamps
> - [ ] `feed_url` is unique
> - [ ] `bun run db:generate` produces a migration, committed under `packages/db/drizzle/`
> - [ ] `bun run db:migrate` applies cleanly to an empty database and is idempotent
> - [ ] Schema tests cover the uniqueness constraint and the default for `is_active`
>
> Out of scope: any API procedure, admin UI, feed fetching.

Small, checkable, and it blocks exactly the Issues that need the table.

### Badly scoped

> **Implement authentication**

Three problems: it is several weeks of work, "done" is undefined, and it silently
spans schema, API, both frontends and authorization policy. It becomes:
application user model → user identity model → local provider → auth middleware
→ protected procedures → authorization foundation → external provider adapter.

> **Improve the API**

No outcome, no criteria, nothing to review against.

> **Add articles**

Ambiguous by an order of magnitude: a table? ingestion? a list endpoint? a UI?
Ranking? Each is its own Issue.

### Rules of thumb

| Signal                                                    | Likely too big |
| --------------------------------------------------------- | -------------- |
| The title contains "and"                                  | ✓              |
| Acceptance criteria span more than one architectural layer without a single user-visible outcome | ✓ |
| More than about eight acceptance criteria                 | ✓              |
| You cannot name what is out of scope                      | ✓              |
| The diff would plausibly exceed a few hundred lines       | ✓              |

Too small is a real failure too. An Issue that cannot be verified on its own —
"add a type alias" — should be folded into the change that needs it.

---

## Picking one up

1. **Choose an unblocked Issue.** Each says what it depends on. Do not start one
   whose dependencies are open.
2. **Investigate before planning.** Find the layer, find the nearest existing
   example, read it. `apps/api/src/modules/system/` is the reference shape for
   an API module.
3. **Plan against the criteria.** Write the checklist down. If the plan needs a
   decision the Issue and `docs/architecture.md` do not settle, stop and ask
   (§2 of `AGENTS.md`) rather than inventing a direction.
4. **Implement the smallest coherent change.** Resist the adjacent fix; open an
   Issue for it instead.
5. **Test.** New behaviour needs a test that fails without it.
6. **Verify** — `bun run lint`, `typecheck`, `test`, plus `build`, `verify:lb`
   or `test:e2e` when the change touches builds, the proxy or cross-service
   behaviour. Confirm integration tests actually ran rather than skipping.
7. **Self-review the diff** against the checklist in `AGENTS.md` §7.
8. **Re-check every acceptance criterion** against the code as it now stands.
9. **Open the PR** with the template, `Closes #N`, and each criterion mapped to
   the thing that satisfies it.

---

## Review

A reviewer is checking:

- Does it satisfy every acceptance criterion?
- Does it stay inside the stated scope?
- Does it respect the architectural invariants (`AGENTS.md` §4)?
- Do the tests fail without the change?
- Is anything scaffolding described as finished?

"It works" is not sufficient. A change that works while violating a boundary
costs more later than it saves now.

---

## Honest reporting

The single rule that matters most: **do not describe unfinished work as
finished.**

- A failing test is reported, not omitted.
- A skipped verification step is stated, with the reason.
- A placeholder is labelled a placeholder.
- A known limitation goes in the PR's Notes section.

An Issue that closes with an honest "criteria 1–4 met, criterion 5 blocked
because X" is far more useful than one that closes silently with criterion 5
quietly unmet.
