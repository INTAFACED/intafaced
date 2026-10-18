# Frontend state of truth — operating (refreshed 2026-08-02)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[HISTORY 2026-09-01]** P21 is not live paint (N4). Do not paste the GO-READY brief. Live: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md).

**Status:** Implement program mid-flight · Wave A + P21 + Wave B **desk core** on main · **level recovery required** before next go  
**You (Nitro):** this page + the recovery doc. Full plan only if curious.  
**Next go:** paste `docs/FRONTEND-GO-READY-BRIEF-2026-08-02.md` then **go**.

**Machine gates:** `pnpm frontend:preflight` · `pnpm frontend:residual`

**Level law (read before ship):** [`FRONTEND-LEVEL-RECOVERY-AND-GO-READY-2026-08-02.md`](FRONTEND-LEVEL-RECOVERY-AND-GO-READY-2026-08-02.md)

---

## Verdict

Planning was thorough. Autonomous shipping landed real honesty + modular P21 + useful desk craft. **Operating level drifted down** under compaction (scorecard/Orca/skills/steal-lines underused). Next go must restore level, not only volume.

Product UI = **vendored shell `:8090`**, not `apps/web`.

---

## Source of truth (one chain)

| Order | Doc                                           | Job                               |
| ----- | --------------------------------------------- | --------------------------------- |
| 0     | **Level recovery + go-ready** (2026-08-02)    | Bar · mistakes · residual · tools |
| 1     | **This file**                                 | Live status                       |
| 2     | `FRONTEND-MASTER-METHODOLOGY-2026-07-31.md`   | How · scorecard · free-hands      |
| 3     | `FRONTEND-MASTER-PLAN-WAVE-A-B-2026-07-31.md` | What/when (A/B/C + Admin)         |
| 4     | `STREAM-A-DESIGN-BAR.md`                      | PR reject checklist               |
| 5     | `FRONTEND-OPS-NOW-2026-07-30.md`              | Orca primary eyes                 |
| 6     | `brand-l1-refs/AUDIT-PASS.md`                 | Real visual refs only             |
| 7     | `NITRO-STREAM-A-CLAIM.md`                     | File territory                    |
| 8     | `COLOR-LOCK-P21-PROVISIONAL-2026-07-31.md`    | Palette values                    |

**Ignore for execution:** chat memory vs disk; WORLDCLASS ORIGINAL/ENHANCED as law; “CI green = world-class.”

---

## Locked decisions

| Item                      | Lock                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| Ambition                  | World-class pro trader workbench + Wave Admin track                    |
| Prior UI                  | Inventory only — free hands rebuild allowed                            |
| Wave A before final look  | Yes — **done on main**                                                 |
| Full N1–N4 systems        | Drafted; **not** final — color-first path accepted                     |
| Color                     | **P21 provisional** modular teal                                       |
| Wave C (RSI/MACD panes)   | Later                                                                  |
| Admin                     | After trader A foundation — **A foundation landed; Admin not started** |
| Fake money / fixture seed | Forbidden                                                              |
| Orange brand              | Not sacred                                                             |

---

## Sequence (where we are)

```
✓ Planning locked
✓ go implement
✓ Wave A honesty (core)
✓ P21 color provisional
✓ Wave B desk core (partial vs full B list)
→ NOW  Level recovery (scorecard · Orca · critique · provenance)
→ THEN Residual B (⌘K, deep B3, full B4…) · Admin-0 · Wave C
```

---

## Implement progress (re-derived 2026-08-02)

| PR   | State      | Content                                   |
| ---- | ---------- | ----------------------------------------- |
| #261 | **merged** | Withdraw decimal + receipt + lock         |
| #262 | **merged** | Account / Safe / myorder honesty          |
| #267 | **merged** | Wave A stack + P21 + B5–B8                |
| #295 | **merged** | B9 blotter tools                          |
| #297 | **merged** | B2/B6/B10/B14 + B3 money                  |
| #298 | **merged** | B10 withdraw/record + residual map        |
| #301 | **merged** | B12 OTC/CMS + B4 light mobile             |
| #302 | **merged** | Skip-link, focus, withdraw copy, activity |
| #320 | **merged** | Auth shell P21 tokens + login a11y        |

**P21** lives in tip `intafaced.css` `:root`.

---

## Residual (named — not “later means never”)

See recovery doc §6. Headline:

- Scorecard re-measure + Orca crop pack
- Impeccable/design-taste craft pass
- ⌘K or waiver
- Nitro taste on P21
- Admin-0 · Wave C later

---

## What you do

| When       | You                                     |
| ---------- | --------------------------------------- |
| Always     | Keep **Orca open** when agents prove UI |
| Next phase | Say **go** (agents use GO-READY brief)  |
| Optional   | Re-pick palette id if P21 wrong         |
| Never      | Git / CI / being the test runner        |

---

## Autonomy

| Do                                       | Stop                                           |
| ---------------------------------------- | ---------------------------------------------- |
| Level-compliant Class N ship on Stream A | New palette / “looks like us” after proof pack |
| Admin-0 inventory after you go           | Admin-1 money ops without foundation check     |
| Collision re-derive every session        | Order-route / futures invent                   |

---

_Refreshed 2026-08-02 after adversarial level recovery. Progress table re-derived from `gh pr view` merge state._
