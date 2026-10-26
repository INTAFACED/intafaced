# Look baselines: TEST pictures

Every picture here is a TEST picture, not a live screen. The look gate (`tooling/ci/look-gate`) draws every Customer room, signed in as the TEST account in apps/customer/tests/real-app/look-fixtures.mjs at a frozen 2026-10-21 12:00 UTC. A balance, price, name or figure in these pictures comes from a screen-test fixture and is not a live figure.

Each room folder holds `phone.png` and `computer.png`, taken from a look gate run on `main` in its pinned browser image. The gate compares every new run against them.

A change goes in its own commit. The pull request names each changed room on a line `Baseline-change: <room> — <why>` and needs the independent review (`.claude/rules/design.md`).
