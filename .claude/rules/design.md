# Customer app look: the design system only

Cloud threads load this file; subfolder rule files and hooks do not load there, so the checks below run in CI.

- A customer room (`apps/customer`) and the new look's kit and templates (`packages/ui/src/lit`) take every colour, size, radius and shadow from the kit's role tokens: `var(--lit-*)` (named in `packages/ui/src/lit/contracts.ts`) or today's `var(--if-*)`. Never a hex, `rgb()`, a named colour, a Tailwind palette colour (`bg-red-500`) or a pixel size. A size with no token is written in rem.
- Sides are logical: `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`, and in Tailwind `ms-*`, `pe-*`, `start-*`, `border-s`, `rounded-ss`, `text-end`. Never left or right.
- In the new look (`packages/ui/src/lit` and a migrated room: a room folder whose files import the lit kit) top and bottom are block sides too: `margin-block-start`, `padding-block-end`, `inset-block-start`, and in Tailwind `mbs-*`, `pbe-*`, `inset-bs-*`, `border-be`. Never top or bottom.
- `tooling/ci/look-drift.mjs` refuses raw values and physical sides on changed lines and in new files of rooms and `packages/ui/src/lit` (the kit's own components there may hold structural pixel sizes, never raw colours or left/right). A raw value that must stay (a third party's exact mark colour) ends its line with `look-drift-allow: <reason>`, which the run prints for the reviewer.
- Token values live only in `packages/ui/src/theme/` and `packages/ui/src/lit/` (tokens.ts, lit.css). To add or rename a role, ask the kit's owner; never add one in a room.
- The new look ships behind `data-look="lit"` on the root, off by default. With it off, a room built on a template shows its layout in today's skin.
- A room is built from a `packages/ui` template with fixed slots (warnings, state), in `packages/ui/src/lit/templates/`; it never draws its own refusal or TEST label. Legal slots and risk bands wait for launch prep (owner decision 2026-10-27).
- Look baselines live in `<package>/look-baselines/<room>/`. A builder never changes its own baseline: the change goes in its own commit, the PR body names the room on a line `Baseline-change: <room> — <why>`, and it needs the independent review (`tooling/ci/test-diff-guard.mjs`, `tooling/ci/review-marker.mjs`).
- Illustrative figures carry TEST; blank prices and limits refuse (AGENTS.md product law).
