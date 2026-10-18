# Color lock — P21 (provisional) → **superseded 2026-08-02**

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** **SUPERSEDED.** Reverted to black + orange on 2026-08-02 on the
owner's standing direction, exercising exactly the reversibility this document
promised. Kept rather than deleted because it is the record of why the shell was
teal for two days.  
**Scope:** Stream A shell (`vendor/*/05_Web_Front` on `:8090`)  
**Board:** `docs/styleboard/VIEW-COLOR-PALETTES.html` → **P21 Deep neutral · teal**

## Current lock (2026-08-02)

| Role      | Hex                            |
| --------- | ------------------------------ |
| accent    | `#ff6b00`                      |
| light     | `#ff8534`                      |
| dark      | `#cc5500`                      |
| hover     | `#ff9d5c`                      |
| on-accent | `#1a0a00`                      |
| surfaces  | unchanged from the table below |
| up / dn   | unchanged — trader meaning     |

**What the swap actually cost:** one token block plus **402 hex literals across
65 files**. That is the point worth remembering — the token block alone reaches
a minority of the shell, because the inherited template hard-codes its colours.
The pass is scripted and repeatable at
`vendor/*/05_Web_Front/accent-remap.mjs`; point its `MAP` at the next pair of
scales and re-run. Same shape as `../retheme.mjs`, which did the original
navy→black pass.

A half-applied swap (tokens only) is **worse than either colour** — it leaves a
product that is visibly two brands. `index.html` was living proof: splash dot 1
was teal while dots 2–7 were still on the previous orange ramp, and it shipped
that way on every page load.

## Verdict (as written 2026-07-31)

Nitro locked **P21** for now. This is **not** a forever brand tattoo.

## Modular = easy to change later

| Layer                               | What it is                                                                     | How you change palette                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **Token source of truth**           | `:root` in `vendor/*/05_Web_Front/src/assets/css/intafaced.css`                | Edit the hex block once; chrome that uses `var(--ix-*)` / `var(--accent)` follows         |
| **Legacy template hex**             | Many Vue/CSS literals still carry brand colors (from historical `retheme.mjs`) | Re-run a brand remap (same class of pass used for P21) or gradually replace with CSS vars |
| **What does not change with brand** | Market **up/down** green/red                                                   | Left alone on purpose — traders read them as direction                                    |

**Implication:** picking P21 now does not trap you. Swap to any other board id (P22–P36, P01–P20) by changing tokens (+ optional hex sync). Layout/density language is separate and can graft later.

## P21 values (locked values)

| Role      | Hex       |
| --------- | --------- |
| bg        | `#0a0c10` |
| panel     | `#12151c` |
| border    | `#242a34` |
| text      | `#e8ebf0` |
| muted     | `#8a909c` |
| accent    | `#00c2a8` |
| on-accent | `#041210` |
| up        | `#0ecb81` |
| dn        | `#f6465d` |

Accent scale used in shell: light `#1ad4bc`, dark `#009e89`, hover `#33dcc8`.

## Name debt (deliberate)

CSS still uses `--ix-orange*` **names** so existing call sites do not break. **Values** are teal. Rename to `--ix-accent*` in a later cleanup if desired — not required for modularity.

## Out of scope this lock

- Full dual-tone layout / density language (Wave B craft)
- Pure-black logo art beyond simple fill remaps
- `apps/web` (not Stream A)

## Proof of modularity for Nitro

You can reverse or re-pick by saying another palette id; agent changes the token block (and remaps leftover brand hex if needed). No rebuild of the product around a color.
