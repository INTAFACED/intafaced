# Look baselines: TEST pictures

Every picture here is a TEST picture, not a live screen. The look gate (`tooling/ci/look-gate`) draws every Customer room, signed in as the TEST account in apps/customer/tests/real-app/look-fixtures.mjs at a frozen 2026-10-21 12:00 UTC. A balance, price, name or figure in these pictures comes from a screen-test fixture and is not a live figure.

Each room folder holds `phone.png` and `computer.png`, taken from a look gate run on `main` in its pinned browser image. The gate compares every new run against them.

A change goes in its own commit. The pull request names each changed room on a line `Baseline-change: <room> — <why>` and needs the independent review (`.claude/rules/design.md`).

## Changes

The reason for each re-cut, so a review of the pictures can read it.

- **2026-11-09, `root` (`/`, Home), phone and computer.** Why: main has added rooms to Home's "What is inside today" since the 27 Oct pictures (#7377 support chat, #7288 compromised account, #7349 rulebook and others), so the page is taller. Main look-gate run 42556154969 (on `2b01975c0`) reported only `size 390x3771 → 390x3792` (phone) and `size 1440x2069 → 1440x2111` (computer) for `/`.
  - Source: that run's artifact `look-gate-2` (id 13648716090, digest `sha256:9d9f0674770359efb800305e63876463158aa583107f1ab0cd150706d813edcd`), files `shots/root/phone.png` and `shots/root/computer.png`, copied byte for byte.
  - SHA-256, new (equal to the artifact's files): phone `9e148666a9b84607586cbfd210d4b316bc267737432fd99ecf9dc18586d93867`, computer `c0758a16ea3443bd38096f087a479379a97b01e55bd267b24502e37fc0b3ab2c`.
  - SHA-256, old: phone `b23133db8df4b509294d623e28d4dd08ec562962aef1afe07e4b0ca90332124f`, computer `9c0e03f294c0ee5ed02dcdeccd86a239f3b0598213b0ff77e972cafa215c7238`.
  - Pixel diff, computer (1440×2069 → 1440×2111, +42 rows): rows 0–1541 are identical aligned at the top, and the last 153 rows (the footer) are identical aligned at the bottom. Only old rows 1542–1915, new rows 1542–1957, differ: the four "What is inside today" cards.
  - Pixel diff, phone (390×3771 → 390×3792, +21 rows): rows 0–1863 are identical aligned at the top, and the last 246 rows are identical aligned at the bottom. Only old rows 1864–3524, new rows 1864–3545, differ: the same four cards, stacked.
  - In that band the room counts read Money 30 (was 25), Trade 17 (15), More 25 (19). More's card adds Agents team and Approvals, and every card is taller to fit. No colour, type or layout changes, and no code comes with it.
