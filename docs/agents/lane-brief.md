# Journey thread brief

Fill in the angle brackets; leave out what does not apply. Carry the owner's own message ids and the original brief forward; never a rewritten summary.

**Area:** `<the journeys this thread owns, for example J-wallet-*>` and the folders they touch, `<services/... and apps/...>`. One thread owns an area. When the work needs a change in another area's folders, route it to that area's thread instead of editing there. A redesign lane tells this thread before it changes the area's rooms or journey test files, and this thread does the same for a redesign lane's open PR; nobody waits: whichever PR lands second rebases onto the first (owner decision 2026-10-27).

**Outcome:** every journey in the area passes in the running app on main. Take the one closest to passing first; its steps and slices are its entry in `docs/roadmap/journeys.json`, and the last real-app run on main says which steps pass (`node tooling/scripts/roadmap.mjs --progress --results <report.json>`). Follow `docs/agents/build-slice.md`. Keep going journey after journey; say when one passes on main so the next can start.

**Context:**

- Decisions already made that this area sits on: `<ADR links, seam PRs, refusal catalogue, design tokens>`.
- Open PRs and branches in this area to finish or close: `<numbers>`.
- Seams other areas depend on: `<contracts or events files>`. Land a shared contract first, as its own small PR, so other areas can build on it in parallel.
- Outside services this area refuses for: `<from the slices' outside field>`.

**Out of scope:** other areas' folders, Polish work (looks, copy, performance), refactors the journey does not need, anything needing real money, live credentials or a deploy.

**Done for each slice:** its rows met on main, its test and journey part green, its journey step seen working in the running app, the PR merged with an independent PASS on its head when it needs one.

**Spec text** (when the shared folder is not mounted in the thread's session): `<paste the slice sections>`.
