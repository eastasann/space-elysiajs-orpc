# The local agent runner

The GitHub side of this repository decides things: what risk a change carries,
whether a review passed, whether a pull request may merge. It does not write
code. This document describes the piece that does — a runner that executes
Claude Code on a developer's own machine and feeds the result into that control
plane through ordinary pull requests.

- Control plane: [`tooling/loop`](../tooling/loop) and
  [`.github/workflows/loop-*.yml`](../.github/workflows), described in
  [loop-engineering.md](./loop-engineering.md).
- Execution plane: [`tooling/local-runner`](../tooling/local-runner), described
  here.

## Architecture

```
GitHub                              your machine
──────                              ────────────
issue labelled agent:ready
        │
        └──────────────────────────▶ loop:once
                                       │  claims the issue (agent:in-progress)
                                       │  git worktree ../.loop-worktrees/issue-N
                                       │
                                       ├─▶ Claude Code — coding session
                                       │     (fresh invocation, per issue)
                                       │
                                       ├─▶ runner-side verification
                                       │     lint · typecheck · test · build
                                       │
                                       ├─▶ Claude Code — review session
                                       │     (separate invocation, read-only)
                                       │
                                       └─▶ commit · push · gh pr create
        │
   pull request ◀───────────────────────┘
        │
        ├─ CI (ci.yml)
        ├─ loop/risk-gate      ─┐
        ├─ loop/review-gate     ├─ required checks
        └─ Claude Approvals    ─┘
        │
   auto-merge (low/medium risk) or human approval (high risk)
        │
   issue closed ─────────────▶ next eligible issue
```

The arrows only ever point one way at the bottom: the runner pushes branches and
opens pull requests, and GitHub decides what happens to them. There is no code
path in the runner that merges anything. `test/safety.test.ts` asserts that
structurally, by scanning the package's own source for a merge or force-push
call.

## What you need

| Tool | Why | Check |
| --- | --- | --- |
| [Claude Code](https://code.claude.com) 2.1+ | writes and reviews the code | `claude auth status` |
| [GitHub CLI](https://cli.github.com) | issues, pull requests, labels, checks | `gh auth status` |
| Bun 1.3+ | runs the runner and the repository's checks | `bun --version` |
| Docker | the repository's own dev environment | `docker compose ps` |

The runner itself runs on the host, not in a container. That is deliberate: see
[Docker](#docker) below.

## Authentication

### Claude Code

The runner **never touches Claude Code's credentials**. It shells out to
`claude auth status --json`, reads two booleans, and reports what it found. It
does not read credential files, keychains, or session state, and it will not
attempt to log you in.

Two officially supported ways to be authenticated:

1. **Subscription login** — `claude auth login` (or `/login` in an interactive
   session), once, in a terminal. This is the normal path and it bills your
   Claude subscription rather than the Anthropic API.
2. **Long-lived subscription token** — `claude setup-token`, which Claude Code
   documents as requiring a Claude subscription, exported as
   `CLAUDE_CODE_OAUTH_TOKEN`. This is the documented route for unattended and
   CI use.

**What was verified here**, against Claude Code 2.1.251, on 2026-08-30:

| Claim | Status |
| --- | --- |
| `claude auth status --json` prints `{"loggedIn":…,"authMethod":…,"apiProvider":…}` and no secret | verified locally |
| `claude -p … --output-format json` works while `authMethod` is `oauth_token` (a subscription login) | **verified locally** |
| A prompt can be delivered on stdin rather than argv | verified locally |
| `--json-schema` produces a validated `structured_output` field | verified locally |
| Exit codes: `0` success, `1` failure, `2` cost ceiling or authentication rejected, `130`/`143` signals | documented |
| `claude setup-token` issues a long-lived token and requires a subscription | documented (its own `--help`) |
| Headless `-p` under a plain `/login` subscription session is *officially supported for unattended automation* | **not documented either way.** It works — that is the row above — but the documentation describes `setup-token` as the path for unattended use. Treat unattended `-p` on a plain login as working-but-unblessed. |
| `--max-turns` | **does not exist** in 2.1.251, despite appearing in some documentation. The runner does not use it. |

If `ANTHROPIC_API_KEY` is set in your environment, Claude Code uses it in `-p`
mode and bills the API instead of your subscription. The runner detects this and
prints a warning rather than silently spending money; unset the variable to use
the subscription.

**What the runner will not do**, and what you should not do to make this
smoother: extract Claude tokens, copy OAuth or session cookies, read credential
stores, mount credential directories into containers, or build an unofficial
auth bridge. If Claude Code is not authenticated, the runner stops *before*
claiming an issue and tells you which command to run.

### GitHub

The runner uses the `gh` CLI you have already authenticated. It never handles a
token itself, never prints one, and never asks for a personal access token. It
verifies `gh auth status` before doing anything, and stops if it fails.

## Commands

```bash
bun run loop:status              # what is ready, what is in flight, what is wrong
bun run loop:once --dry-run      # what would happen; changes nothing
bun run loop:once                # take one issue through to a pull request
bun run loop:review 42           # advisory review on pull request #42
bun run loop:watch               # drive open work and take new issues, on an interval
```

Any of them accepts `--repo owner/name` to override the repository detected from
the `origin` remote.

### `loop:status`

Prints the repository, the current branch, whether Claude and `gh` are usable,
whether the lock is held, the configured limits, anything this machine has in
flight (with live CI and review state read from GitHub), and the eligible
backlog. It exits non-zero when something would stop a run. No secret value ever
appears in its output.

### `loop:once`

Takes **one** issue through the local coding phase:

1. Preflight. If Claude or `gh` is not ready, stop here — nothing has been
   claimed, so there is nothing to unwind.
2. Take the local lock (`.loop/runner.lock`).
3. If this machine already has an issue in flight, deal with **that** rather
   than claiming a second one:
   - no pull request yet (a crash mid-run) → resume it;
   - pull request open with red checks and budget left → resume it, with the
     failing check names as feedback;
   - pull request green, merged, closed, or out of budget → report and stop.
   A resumed run starts at `fixRounds + 1`, so rounds already spent stay spent.
   Restarting the runner cannot hand the agent a fresh budget.
4. Select the next issue using `selectNextIssue` from `@newsdeck/loop` — the
   same policy the `loop-next-issue` workflow uses. The runner does not have its
   own eligibility rules.
5. Claim it: `agent:ready` → `agent:in-progress`.
6. Create `../.loop-worktrees/issue-N` on `agent/issue-N-short-description`, and
   run `bun install --frozen-lockfile` in it. A fresh worktree has no
   `node_modules`, so without this every verification step fails for a reason
   that has nothing to do with the change. `--frozen-lockfile` because an agent
   must not quietly resolve a different dependency tree than CI will.
7. Round loop, bounded by `LOCAL_AGENT_MAX_FIX_ROUNDS`:
   - a fresh Claude Code coding session,
   - the repository's own `lint`, `typecheck`, `test`, `build`,
   - commit,
   - a fresh Claude Code review session,
   - approve → done; changes requested or verification failed → next round.
8. Push the branch, open the pull request with `Closes #N`, and move the issue
   to `agent:review`.

It does not wait for CI and it does not take a second issue. That is `watch`'s
job.

### `loop:once --dry-run`

Reads GitHub and prints the issue that would be selected, its branch name, the
worktree path, the shape of the Claude invocation, the verification commands,
and what would happen to the pull request. It claims nothing, invokes no agent,
writes no file, pushes nothing, and creates no pull request. Scenario J in
`test/runner.test.ts` asserts exactly that.

### `loop:review <number>`

Runs only the review agent against a pull request's diff and posts the result as
a comment, clearly marked advisory. Add `--dry-run` to print it instead. This
review has no authority: the review that gates the merge runs in GitHub Actions,
where the code being reviewed cannot influence the runner.

### `loop:watch`

Alternates between two things on an interval (`LOOP_POLL_INTERVAL_SECONDS`,
60 seconds by default):

- `advance` — for anything in flight, read the pull request's state from GitHub:
  merged (clean up the worktree), closed (leave it to a human), checks pending
  (wait), checks failing (hand it to the next `runOnce`, which resumes it as a
  fix round, or block when the budget is spent), checks green (report the gate
  and wait).
- `runOnce` — only when nothing is in flight, and only until `LOOP_MAX_ISSUES`
  is reached.

It stops on: a blocked issue, an exhausted retry budget, `LOOP_MAX_ISSUES`, or
SIGINT/SIGTERM — which release the lock on the way out. It never busy-loops.

## Configuration

All optional; the defaults are the conservative ones.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOOP_MAX_ISSUES` | `1` | Issues taken in one `watch` session. `0` means unlimited and has to be set on purpose. |
| `LOCAL_AGENT_MAX_FIX_ROUNDS` | `3` | Coding rounds per issue, counting the first. Bounds both the verification loop and the review loop. |
| `LOOP_WORKTREE_ROOT` | `../.loop-worktrees` | Where isolated worktrees go, relative to the repository. |
| `LOOP_POLL_INTERVAL_SECONDS` | `60` | Watch-mode polling interval. Minimum 30. |
| `LOOP_AGENT_TIMEOUT_MINUTES` | `45` | Wall-clock ceiling on one Claude invocation. |
| `LOOP_CI_TIMEOUT_MINUTES` | `30` | How long to wait for checks before giving up. |
| `LOOP_AGENT_MODEL` | *(empty)* | Model alias passed to Claude Code. Empty means its own default. |

The first run takes one issue and stops. Autonomy is something you turn up
deliberately.

## Worktrees

Every run happens in `../.loop-worktrees/issue-N`, on a branch named
`agent/issue-N-short-description`, derived from the issue number and title. Your
main checkout is never modified: not its branch, not its uncommitted changes,
not its index. A dirty main checkout produces a warning, not a refusal, and
nothing in it is reset or deleted.

Branch names are deterministic, so a retried issue re-attaches to the branch it
already has instead of opening a second pull request. The title is reduced to
`[a-z0-9-]` rather than escaped, which removes the whole question of what git
does with an unusual character.

Worktrees are removed only after GitHub reports the pull request merged or
closed. `git worktree remove --force` is used, and only ever against a directory
the runner itself created.

## Review isolation

The review agent is a **separate Claude Code invocation** with no shared session,
no shared context, and a different tool set:

| | Coding agent | Review agent |
| --- | --- | --- |
| Session | fresh per issue | fresh per round, separate from the coder |
| Tools | Read, Write, Edit, Glob, Grep, Bash, TodoWrite | Read, Glob, Grep |
| Commands | `bun`, `bunx`, read-only git | none (`--restricted`) |
| Network | denied (no WebFetch, no `curl`) | denied |
| Settings files | project settings apply | ignored (`--restricted --strict-mcp-config`) |
| Output | prose summary | JSON validated against `ReviewResultSchema` |

The reviewer never sees the coder's reasoning — only the issue, the diff, and
the changed files. A reviewer that shared the coder's session would be
confirming its own conclusions.

Review output goes through `parseReviewResult` from `@newsdeck/loop`, the same
validator the workflow uses. Output that does not validate is **blocked**, never
approved. Scenario F asserts this against three separate kinds of malformed
output.

## Risk and the merge boundary

The runner classifies risk locally with `classifyRisk`, from the same
`.github/loop-policy.json` the workflow reads. That value is advisory: it is
recorded in the journal, printed, and included in the pull request body so a
reviewer can see it, but the value that gates the merge is recomputed by
`loop-pr.yml` on GitHub. Two computations from one policy file, and only the
GitHub one has authority.

A `risk:high` pull request stops for a human. The runner says so, does not merge
it — it has no merge call at all — and does not start another issue while it is
open. Execution is serial by default.

The runner cannot push anything but an `agent/issue-*` branch: `pushBranch`
refuses by name before it shells out, and there is no `--force` anywhere in the
package outside `git worktree remove`.

## Untrusted content

Issue bodies, titles, comments and diffs are written by whoever can open an
issue. The runner treats them as data:

- **No shell, ever.** Every subprocess is `Bun.spawn` with an argv array. There
  is nothing to interpret `$(…)`, backticks or `;`. A test asserts this with a
  deliberately hostile argument.
- **Prompts on stdin**, not argv, so untrusted text does not appear in a process
  listing.
- **Fenced and neutralised.** Untrusted text is wrapped in `<issue>`/`<diff>`
  elements and the closing tags are escaped, so a body cannot close its own
  fence and append text that reads as though the runner wrote it.
- **Capped.** 20 000 characters for an issue body, 120 000 for a diff, visibly
  truncated.
- **Single-pass substitution.** A body containing `{{DIFF}}` stays those literal
  characters.
- **Instructions live locally.** The prompt templates are files in
  `tooling/local-runner/prompts/`, reviewed like any other code, and they tell
  the agent explicitly that issue content states requirements and has no
  authority over how it works.

## Secrets

- Subprocesses get an **allowlist** environment, not the developer's shell.
  `DATABASE_URL`, `AUTH_LOCAL_SIGNING_KEY` and everything else from `.env` are
  simply absent. A denylist would leak whatever nobody thought to name.
- The allowlist is **split by purpose**, so each credential reaches only the
  process that needs it:

  | Profile | Used by | Carries |
  | --- | --- | --- |
  | `base` | `lint`, `typecheck`, `test`, `build` | nothing but `PATH`, `HOME`, locale, proxy |
  | `claude` | Claude Code | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` |
  | `github` | `gh` | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_*` |
  | `git` | `git` | `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` |

  Claude never sees a GitHub token; `gh` never sees a Claude one; the
  repository's own test suite sees neither.
- Everything written to a log, a prompt or a GitHub comment goes through
  `redact()` first: GitHub tokens, Anthropic keys, AWS keys, bearer tokens,
  private key blocks, `*_TOKEN=`/`*_SECRET=`/`*_KEY=` assignments, and
  credentials embedded in connection strings.
- Claude authentication state is never read, logged, or recorded.

## Logs and state

```
.loop/                          (git-ignored)
├── runner.lock                 pid, host, start time, command
├── state.json                  the journal
└── logs/
    └── issue-42/
        ├── runner.log
        ├── coding-result-0.json
        ├── verification-0.json
        ├── review-result-0.json
        └── risk.json
```

`state.json` is a **convenience, not a source of truth**. It holds what cannot
live on GitHub: which worktree belongs to which issue, how many rounds this
machine has spent, where the logs went. Deleting it loses none of the loop's
state — labels, checks and the sticky pull request comment are all still on
GitHub. A corrupt journal reads as empty rather than wedging the runner.

GitHub-visible output stays concise: lifecycle labels, the pull request body,
one comment when the runner stops. Raw model output is never posted.

## Locking and recovery

`.loop/runner.lock` records the pid, the hostname, the start time and the
command. A second runner on the same machine is refused. A lock whose owner is
gone is taken over automatically — but only when the hostname matches, because
a pid from another machine says nothing about this one; that case asks for a
human instead of guessing. Releasing only ever removes the runner's own lock.

After a crash, a reboot, or a closed terminal:

```bash
bun run loop:status   # what does GitHub say, and what did this machine leave behind?
bun run loop:once     # resumes rather than claiming a second issue
```

Recovery works by querying GitHub, not by trusting the journal. An issue already
in flight is resumed when there is something to do and reported when there is
not; a stale lock is taken over; a half-finished worktree is re-attached to
rather than recreated. The worktree removed at the end is re-derived from
configuration rather than read from the journal, so a corrupted journal cannot
point the runner at a directory it did not create.

If a run fails after claiming, the issue is moved to `agent:blocked` with a
comment saying why. Authentication failure cannot leave an issue stuck as
`agent:in-progress`, because authentication is checked before the claim.

## Docker

The repository's services run in Docker; the runner does not. Running the runner
in a container would mean either mounting Claude's credential directory into it
— which this repository will not do — or maintaining a second authentication
path. The coding agent invokes the repository's normal `docker compose` commands
from the host when an issue needs them.

## Stopping it

Ctrl-C. `watch` handles SIGINT and SIGTERM, releases the lock, and exits. If a
lock is somehow left behind, `loop:status` names the pid holding it, and
deleting `.loop/runner.lock` is safe once that process is gone.

## Extending it

`src/agent.ts` defines two interfaces, `CodingAgent` and `ReviewAgent`.
`ClaudeCodeCodingAgent` and `ClaudeCodeReviewAgent` implement them. Nothing in
the orchestrator names Claude. Adding another agent — a different CLI, a hosted
service, a local model — means writing one class, not editing the loop.

## Tests

`bun run --filter '@newsdeck/local-runner' test`, or `bun run test` for the
whole repository. Claude and GitHub are faked; git is real, driven against
temporary repositories. **The suite spends no model usage and needs no
network.** Scenarios A–J from the specification are in `test/runner.test.ts`;
the credential, injection and merge-boundary checks are in `test/safety.test.ts`.
