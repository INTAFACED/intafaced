# Journey thread brief

Fill in the angle brackets; leave out what does not apply. Carry the owner's own message ids and the original brief forward; never a rewritten summary.

**Lane:** `<lane name from docs/roadmap/slices.json>`, folders `<services/... or apps/customer/src/features/...>`. No other lane edits these folders.

**Outcome:** the slices in this lane's queue (`node tooling/scripts/roadmap.mjs --lane "<lane>"`) built and merged, trader-journey slices first, starting with `<first slice id>`. Follow `docs/agents/build-slice.md`.

**Context:**

- Decisions already made that this lane sits on: `<ADR links, seam PRs, refusal catalogue, design tokens>`.
- Seams frozen for this lane's journey: `<contracts or events files>`. A change to them goes to `<owner thread>` first.
- Outside services this lane refuses for: `<from the slices' outside field>`.

**Out of scope:** other lanes' folders, Polish work (looks, copy, performance), refactors the slice does not need, anything needing real money, live credentials or a deploy.

**Done for each slice:** its rows met on main, its test and journey part green, its journey step seen working in the running app, the PR merged with an independent PASS on its head. The thread keeps going across slices until its journey passes on main.

**Spec text** (when the shared folder is not mounted in the lane's session): `<paste the slice sections>`.
