---
name: Bug
about: Something behaves differently from how it is documented or intended
title: ''
labels: bug
assignees: ''
---

## Summary

<!-- What is wrong, in one sentence. -->

## Expected behaviour

<!-- What should happen, and where that is documented or specified. -->

## Actual behaviour

<!-- What happens instead. Include the correlation id (`x-request-id`) from the
     failing request when there is one — it links the browser, the web tier, the
     API and the worker logs together. -->

## Reproduction

1.
2.
3.

## Environment

- Ran via: <!-- `docker compose up` / host-mode `bun run dev` -->
- Affected service(s): <!-- web / admin / api / worker / proxy / db / redis -->
- Commit:

## Acceptance Criteria

- [ ] A test reproduces the failure and fails before the fix
- [ ] The fix makes that test pass
- [ ]

## Out of Scope

-
