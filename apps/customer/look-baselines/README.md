# Look baselines: TEST pictures

Every picture here is a TEST picture, not a live screen. The look gate (`tooling/ci/look-gate`) draws every Customer room, signed in as the TEST account in apps/customer/tests/real-app/look-fixtures.mjs at a frozen 2026-10-21 12:00 UTC. A balance, price, name or figure in these pictures comes from a screen-test fixture and is not a live figure.

Each room folder holds `phone.png` and `computer.png`, taken from a look gate run on `main` in its pinned browser image. The gate compares every new run against them.

A change goes in its own commit. The pull request names each changed room on a line `Baseline-change: <room> — <why>` and needs the independent review (`.claude/rules/design.md`).

## Changes

The reason for each re-cut, so a review of the pictures can read it.

- **2026-11-09, `root` (`/`, Home), phone and computer.** Taken unchanged from main look-gate run 42556154969 (on `2b01975c0`, artifact `look-gate-2`, `shots/root/`); SHA-256 of the new files: phone `9e148666a9b8…`, computer `c0758a16ea34…` (the old ones: `b23133db8df4…`, `9c0e03f294c0…`). Why: main has added rooms to Home's "What is inside today" since the 27 Oct pictures (#7377 support chat, #7288 compromised account, #7349 rulebook and others), so the page is taller: that run reported only `size 390x3771 → 390x3792` (phone) and `size 1440x2069 → 1440x2111` (computer) for `/`. The old and new pictures are pixel-identical above that section (rows 0–1541 on computer, 0–1863 on phone). In it, the room counts read Money 30 (was 25), Trade 17 (15), More 25 (19), with More's card adding Agents team and Approvals; every card is taller to fit, and the page below moves down. No colour, type or layout changes. No code changes come with it.
