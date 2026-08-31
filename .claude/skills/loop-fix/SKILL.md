---
name: loop-fix
description: Address review findings or failing CI on an existing pull request for the autonomous loop. Use when the loop dispatches a fix round.
allowed-tools: Read, Write, Edit, Glob, Grep, TodoWrite, Bash(bun *), Bash(bunx *), Bash(git *), Bash(gh pr view *), Bash(gh pr diff *), Bash(gh pr checks *), Bash(gh issue view *), Bash(gh run view *)
---

# Fix round for the autonomous loop

You are invoked as:

```
/loop-fix <owner/repo> <pull-request-number>
```

Read `AGENTS.md` first and follow it exactly.

This is a bounded retry. The loop allows a small number of rounds per pull
request and then blocks the issue for a person, so spend this round fixing
everything you can rather than half of it.

## What to do

1. Gather what went wrong:
   - `gh pr view <number> --repo <owner/repo> --json title,body,headRefName,comments`
   - `gh pr checks <number> --repo <owner/repo>` for failing checks, then
     `gh run view <run-id> --log-failed` for the actual failure
   - The loop posts its verdict as a comment containing the review findings.
     Read the most recent one.
2. Check out the pull request's head branch and reproduce the failure locally
   before changing anything. A fix for a failure you have not reproduced is a
   guess, and a wrong guess costs a whole round.
3. Address **every** finding and every failing check. If you believe one is
   wrong, fix the rest and say clearly in a pull request comment which you did
   not act on and why — do not silently skip it.
4. Re-run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
5. Commit and push to the same branch. Do not open a second pull request.

## Boundaries

- **Never make a check pass by weakening it.** Deleting a test, skipping it,
  adding `.only`, replacing an assertion with one that cannot fail, or reaching
  for `@ts-nocheck` are all detected and will block the merge rather than
  unblock it. If a test is genuinely wrong, say so and explain why.
- **Never edit the rules that judge you** — `.github/workflows/**`,
  `.github/loop-policy.json`, `tooling/loop/**` — to make this pull request
  pass. That is detected too, and it is the one thing that still stops for a
  person.
- Do not widen the change beyond what the findings and the issue call for.
- Do not merge, approve, or force-push.

## Finish

Leave a comment on the pull request saying what you changed and the status of
each item you were asked to address. If something cannot be fixed in this round,
say which and why: the loop marks the issue blocked and moves on, which is a
better outcome than a claim of completion that turns out to be false.
