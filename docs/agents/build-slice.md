# Build a slice

Read this when a brief names a slice id (like SP-order-entry-02), a journey or a lane queue, or asks for the independent review of a slice PR. A slice is one row of `docs/roadmap/slices.json`: a spec in the shared Operation Zero folder, a lane that builds it, what it touches and what it needs first. `AGENTS.md` holds the rules; this file is how a thread applies them to a slice, and what the reviewer checks. Where the two disagree, `AGENTS.md` wins.

## Pick

1. Your journey's slices: its steps in `docs/roadmap/journeys.json` name them (one lane's queue: `node tooling/scripts/roadmap.mjs --lane "<lane>"`). Take the first slice whose dependencies are merged, on the step closest to passing. A slice's `later` list names slices its spec also mentions that come after it (a two-way pair, untangled by the script): where your slice reaches one, refuse with a typed code.
2. Read the slice's spec: `/mnt/project-files/operation-zero/<spec field>`, the section headed with its id. When that folder is not mounted, the brief carries the spec text.
3. Re-check every `file:line` the spec cites against today's main. The specs were written against main of 2026-10-18. Drop what is already built and say so in the PR.
4. Read your service's leftover review findings, `/mnt/project-files/status/review-leftovers/<service>.md`, money and key items first. An item that is still real in code this slice touches (a fresh failing test on main proves it) gets fixed in the same PR; otherwise mark it gone there with a one-line reason.

## Build: the bar

Fast on what is cheap to change later, right first time on what is expensive. Cheap, left for Polish: looks, copy, layout, performance, tidiness inside a module, docs prose.

1. **Money.** Value moves only through `packages/ledger-client` recipes; business idempotency keys; an invariant test; every failure branch tested. Ask where funds are stranded if it crashes at each step.
2. **Data shape.** New tables: stable ids, scoped to the owning user or org, money as `numeric` with 18 decimal places, matching the service's existing columns (decimal strings on the wire, scaled bigint in memory), created and updated timestamps. Migrations are the hardest thing to undo.
3. **Interfaces.** Contracts and events first in the change (`packages/contracts`, `packages/events`), versioned; apps take their types from contracts too. Contracts, one service and its screen land together in the slice's one PR; a change that reaches a second service is two PRs, seam first.
4. **Ownership.** Every new endpoint checks that the caller owns what it reads or changes, and asks for step-up on sensitive actions. This was the most common real bug in past reviews.
5. **Front end.** Use the shell, tokens, shared components and the one refusal catalogue; never re-invent them.
6. **Honest states.** Typed refusals from the first commit; a missing rail or vendor refuses with the allowlisted notice while the rest of the slice is built in full; no fake numbers (illustrative figures say TEST). An owner setting that refuses when blank on the slice's journey path, new or already there, gets a labelled TEST value in `tooling/profiles/test-owner-values/<service>.json` (the file named for its `service` key), then run `node tooling/scripts/owner-settings.mjs`, so the slice's journey step can pass on the test stack. A service's env on the local test stack lives in `tooling/scripts/local-stack-services/<name>.mjs`; change that file, not `local-test-stack.mjs`. Production stays blank until the owner sets it.
7. **Proof.** A test that fails without the slice, plus the slice's part of its journey test, plus the step seen working in the running app: `pnpm local:stack`, then drive it in a browser (Playwright on the machine's Chromium) and write what you saw in the PR body. If the stack cannot start, say exactly why. The journeys are the definition of done: `/mnt/project-files/operation-zero/modules/<module>/acceptance/journeys.md` names the steps your slice serves (`docs/roadmap/journeys.json` lists them).
8. **Reuse.** Search shared packages (`rg`) before writing a helper.
9. **Scope.** Build the slice as specced. "REPLACE" means that edge only; no drive-by rewrites, no extras.

## Ship

- One PR per slice: its contracts or events, one service and that service's screen together. Title: `<service>: <slice id> <what a user gets>`, for example `svc-trade: SP-order-entry-02 market order by value`. Two slices of the same journey may share a PR when they touch the same files.
- Prefer new files over edits to shared ones, and register them through the area's own routes or router file, so a shared root file changes by one import line. Threads that share a service then rarely conflict.
- Before push: affected tests, typecheck, `pnpm exec prettier --check` on changed files, the running-app proof (bar 7), and an automated code review of the diff (for example `/code-review`; a money, security or gate-file PR also `/security-review`). Fix their findings or say in the PR body why not.
- Open as ready, turn auto-merge on (AGENTS.md "Check, then merge" item 8), ask for the independent review if it needs one (below), end the turn. Opening the PR already subscribes you to its activity; subscribing again only delivers the same long notice twice. No check-ins, no polling.
- The slice counts as built when its journey steps pass on the real stack built from main, not when the PR merges. A slice you could only part-build stays open: say which rows are left in the PR body.

## Independent review

A money, security or gate-file PR gets one (AGENTS.md "Check, then merge" item 2). A different session reviews the exact head, never the author's: in a project, the review thread; ask for it with the PR number, the head sha and the slice id. It follows [reviewer-brief.md](reviewer-brief.md) and posts `Independent review: PASS <sha>` or its blocking findings. One review per head, diff only; fix blocking findings and ask again for the new head. After three rounds on one PR, step back and rethink the approach instead of a fourth.

## Briefing a new thread

A coordinator starting a journey thread fills in [lane-brief.md](lane-brief.md).
