# Tracker thrash protocol (D26-P4-08)

**Status:** BINDING · **batch rule for agents**  
**Tracker:** D26-P4-08  
**Law home (do not collapse):** [`COORDINATION-TRUTH-LAYERS.md`](COORDINATION-TRUTH-LAYERS.md)  
**This file:** when agents **MAY** vs **MUST NOT** edit `tooling/tracker/features.mjs` (and the generated `docs/TRACKER.md`).  
**Not:** a second product SoT, a keepalive ritual, or a CI tax.

---

## 1 · One rule

Touch `features.mjs` only on a **mountain event**, in the **same PR as that event**.  
Craft, keepalive, and “board unchanged” are **not** mountain events.

Denon intent: the product map must not **lie** about free / owner / done. That is **not** “maximize `features.mjs` diffs.”

---

## 2 · MAY edit (`features.mjs` + `pnpm tracker`)

| Event                             | What to write                                                                     | Same PR as                                               |
| --------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Claim** a free product mountain | `owner` + `status: 'wip'`                                                         | First implement PR for that mountain                     |
| **Handoff / human lock**          | `owner` (e.g. `shehzad002`) + note why agents babysit                             | The ownership change                                     |
| **Done**                          | `status: 'done'` + `requires` paths that exist on disk                            | The ship that meets the constitution / DoD bar           |
| **Cut**                           | Honest cut note + §13 socket — **not** fake `done`                                | The cut                                                  |
| **Wave note** (optional)          | Refresh `note` **once** after a merge wave that **materially** moves the mountain | That wave’s real product/law PR — not a notes-only stamp |

After a MAY edit: run `pnpm tracker` and commit **registry + generated `TRACKER.md` together**. Do not hand-edit `TRACKER.md`.

Session dual-build prevention stays **LIVE-LANES + open PRs**. That claim is **not** a `features.mjs` edit.

---

## 3 · MUST NOT edit

| Temptation                                                                           | Why it is thrash                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Every craft / a11y / polish PR under an already-`wip` row                            | Mountain already claimed; git is the code SoT                 |
| Keepalive, peace, cycle stamp, “board unchanged”, FREEZE tip-bump, claims-only meter | Coordination PR ban — files, not PRs                          |
| Pure docs that do not change product ownership                                       | Layers: docs-only is not a mountain event                     |
| Path refactors that do not change feature meaning                                    | Same mountain, new files — wait for done/cut/wave             |
| Research / TRK packs as the only delta                                               | Packs do not claim or close mountains                         |
| Touching the registry to satisfy value-gate / “look busy”                            | Gate **explicitly** does not ask for `features.mjs`           |
| CI rule: any code path requires a `features.mjs` diff                                | **Hard reject** in COORDINATION-TRUTH-LAYERS — never add this |

**Sibling lanes:** D26-P0-05 / D26-P4-09 may refresh **notes** on honesty passes. This protocol does **not** authorize those edits from a craft PR, and this PR does **not** edit `features.mjs` or `TRACKER.md`.

---

## 4 · What still runs (honesty, not tax)

| Mechanism            | What it does                           | What it must not become        |
| -------------------- | -------------------------------------- | ------------------------------ |
| `pnpm tracker:check` | Blocks **false `done`** / stale render | “Must edit registry every PR”  |
| LIVE-LANES claim     | Hour-scale dual-build lock             | Collapsed into `features.mjs`  |
| `pnpm claim:check`   | Path / owner conflict                  | A reason to bump tracker notes |

---

## 5 · Collision / out of scope

Do **not** use this file to rewrite COORDINATION-TRUTH-LAYERS, the coordination finish audit, P4-01 spine disposition, or P4-07 vendor money-map ADR. Vue is out of lane (`nitro-frontend-all`).
