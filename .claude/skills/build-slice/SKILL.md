---
name: build-slice
description: Build one Operation Zero slice (an id like SP-order-entry-02) in a lane, or review a slice PR. Use when a brief names a slice id or a lane queue, or asks for the independent review of a slice PR.
---

# Build a slice

A slice is one row of `docs/roadmap/slices.json`: a spec in the shared Operation Zero folder, a lane that builds it, what it touches and what it needs first. `AGENTS.md` holds the rules; this skill is how a lane applies them to a slice, and what the reviewer checks. Where the two disagree, `AGENTS.md` wins.

## Pick

1. Your lane's queue: `node tooling/scripts/roadmap.mjs --lane "<lane>"` (or `--journey trader`). Take the first slice whose dependencies are merged. Trader-journey slices go first.
2. Read the slice's spec: `/mnt/project-files/operation-zero/<spec field>`, the section headed with its id. When that folder is not mounted, the brief carries the spec text.
3. Re-check every `file:line` the spec cites against today's main. The specs were written against main of 2026-10-18. Drop what is already built and say so in the PR.
4. If a build pack exists for the slice (`/mnt/project-files/grok-week/packs/<lane>/<slice-id>.md`), read it first and verify its claims as you go. Note in your status file whether it was wrong anywhere or saved exploring.
5. Read your service's leftover review findings, `/mnt/project-files/status/review-leftovers/<service>.md`, money and key items first. An item that is still real in code this slice touches (a fresh failing test on main proves it) gets fixed in the same PR; otherwise mark it gone there with a one-line reason.

## Build: the bar

Fast on what is cheap to change later, right first time on what is expensive. Cheap, left for Polish: looks, copy, layout, performance, tidiness inside a module, docs prose.

1. **Money.** Value moves only through `packages/ledger-client` recipes; business idempotency keys; an invariant test; every failure branch tested. Ask where funds are stranded if it crashes at each step.
2. **Data shape.** New tables: stable ids, scoped to the owning user or org, money as `numeric` with 18 decimal places, matching the service's existing columns (decimal strings on the wire, scaled bigint in memory), created and updated timestamps. Migrations are the hardest thing to undo.
3. **Interfaces.** Contracts and events first (`packages/contracts`, `packages/events`), versioned; apps take their types from contracts too. A cross-service change is two PRs, seam first.
4. **Ownership.** Every new endpoint checks that the caller owns what it reads or changes, and asks for step-up on sensitive actions. This was the most common real bug in past reviews.
5. **Front end.** Use the shell, tokens, shared components and the one refusal catalogue; never re-invent them.
6. **Honest states.** Typed refusals from the first commit; a missing rail or vendor refuses with the allowlisted notice while the rest of the slice is built in full; no fake numbers (illustrative figures say TEST).
7. **Proof.** A test that fails without the slice, plus the slice's part of its journey test.
8. **Reuse.** Search shared packages (`rg`) before writing a helper.
9. **Scope.** Build the slice as specced. "REPLACE" means that edge only; no drive-by rewrites, no extras.

## Ship

- One service (or one app area) per PR. Title: `<service>: <slice id> <what a user gets>`, for example `svc-trade: SP-order-entry-02 market order by value`. Two slices of the same lane may share a PR when they touch the same files.
- Prefer new files over edits to shared ones, and register them through the area's own routes or router file, so a shared root file changes by one import line. Lanes that share a service then rarely conflict.
- Before push: affected tests, typecheck, `pnpm exec prettier --check` on changed files.
- Open as ready, turn auto-merge on (AGENTS.md item 8: in-repo, listed author, never a gate-file PR), subscribe to the PR, start the independent review (below), end the turn. No check-ins, no polling.
- The slice counts as built when its rows are met on main, not when the PR merges. A slice you could only part-build stays open: say which rows are left in the PR body.

## Independent review

Run it as a separate agent on the exact head (Sonnet; Opus for money, ledger, custody or auth changes). Give it [reviewer-brief.md](reviewer-brief.md), the PR number, the head sha and the slice id. It posts `Independent review: PASS <sha>` or its blocking findings. One review per head, diff only; fix blocking findings and review the new head.

## Briefing a new lane

A coordinator or lead starting a lane thread fills in [lane-brief.md](lane-brief.md).
