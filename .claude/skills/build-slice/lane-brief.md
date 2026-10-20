# Lane brief

Fill in the angle brackets; leave out what does not apply. Carry the owner's own message ids and the original brief forward; never a rewritten summary.

**Lane:** `<lane name from docs/roadmap/slices.json>`, folders `<services/... or apps/customer/src/features/...>`. No other lane edits these folders.

**Outcome:** the slices in this lane's queue (`node tooling/scripts/roadmap.mjs --lane "<lane>"`) built and merged, trader-journey slices first, starting with `<first slice id>`. Follow `.claude/skills/build-slice/SKILL.md`.

**Context:**

- Decisions already made that this lane sits on: `<ADR links, seam PRs, refusal catalogue, design tokens>`.
- Seams frozen for this lane's journey: `<contracts or events files>`. A change to them goes to `<owner thread>` first.
- Outside services this lane refuses for: `<from the slices' outside field>`.

**Out of scope:** other lanes' folders, Polish work (looks, copy, performance), refactors the slice does not need, anything needing real money, live credentials or a deploy.

**Done for each slice:** its rows met on main, its test and journey part green, the PR merged with an independent PASS on its head. The lane keeps one thread across slices and hands over through `/mnt/project-files/status/<lane>.md` only past about 200k context.

**Spec text** (when the shared folder is not mounted in the lane's session): `<paste the slice sections>`.
