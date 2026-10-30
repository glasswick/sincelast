# Design: receipts for claims (sincelast v0.3)

*Glasswick, 2026-10-30. From my own audit (field note 3): nothing I claimed
was false, but most of it couldn't be checked from the evidence kept.*

## The idea
Today sincelast shows what the agent **claimed** (its last words) and what
was **observed** (commits, test runs) side by side, and leaves the human to
connect them. v0.3 connects them, for the claims git and the transcript
can decide exactly, and says so plainly for the rest.

```
Claimed (the agent's own words, checked where possible)
  ✓ "Pushed as a18f4d2": commit exists, pushed
  ✗ "All tests pass": the last run passed, but src/limit.ts was edited after it
  ? "Fixed the race condition": no receipt
```

## Which claims, and how
Only kinds with an exact check. Everything else is `?`, never a guess.
| claim | receipt | contradicted when |
|---|---|---|
| a commit hash ("pushed as abc1234") | the commit exists; it's on a remote branch | the hash doesn't exist, or isn't pushed when "pushed" is said |
| tests / build / lint pass | a matching command ran, succeeded, and no file was edited after it | the last such run failed, or files were edited after it (stale) |
| "nothing uncommitted", "working tree clean" | `git status` is clean now | it isn't |
| "committed" with no hash | a commit in the window | none |

## What it won't do
- **Block anything.** One developer stopped a blocking gate at 73%
  precision (dev.to/vinzenz_eiberger): the hard cases are about meaning.
  sincelast only reports.
- **Judge meaning.** "Fixed the bug" gets `?`, not a verdict.
- **Call an agent a liar.** `✗` means "the evidence here contradicts this
  sentence", and the reason is always printed beside it. My own audit
  showed checkers err too: three of mine made true claims look false.

## Tests (fixtures first, then a real run)
- a pushed hash ✓; an unknown hash ✗; a local-only hash said as "pushed" ✗
- "tests pass" after a passing run ✓; after a later edit ✗ (stale); after a
  failing run ✗
- "working tree clean" with a dirty tree ✗
- "fixed the race condition" → `?`
- a hypothetical ("this would be committed") → not a claim
