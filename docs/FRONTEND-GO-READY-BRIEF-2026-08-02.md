# GO-READY brief — Stream A (paste when Nitro says **go**)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[HISTORY 2026-09-01]** Not a live paste. Codex: [`PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md`](PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md). Map: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md).

**Do not ship under-level.** Read first:

1. `docs/FRONTEND-AUTONOMOUS-OPERATING-SYSTEM-2026-08-02.md` (**architecture**)
2. `docs/FRONTEND-LEVEL-RECOVERY-AND-GO-READY-2026-08-02.md` (hole-poke)
3. methodology · plan · Design Bar · OPS-NOW · claim · COLOR-LOCK

## Boot command

```bash
git fetch origin main
# worktree from tip — never main checkout
pnpm frontend:preflight          # must exit 0
pnpm frontend:residual           # print next priorities
```

If preflight fails: **stop**. Fix law/tools before product code.

## Goal

World-class **pro trader workbench** on `:8090`. Free hands. No fake money. One kit (iView). Nitro never runs git.

## Already on main (do not redo blindly)

Wave A honesty · P21 · B5–B10/B12/B14 partial · hotkeys #337 · book honesty #349 · see residual-register.json

## First work after go (fixed order — no asking Nitro)

| Order | ID                     | Work                                                        |
| ----- | ---------------------- | ----------------------------------------------------------- |
| 1     | META-SCORECARD         | PROOF-1 re-score + Orca pack → `FRONTEND-SCORECARD-LIVE.md` |
| 2     | META-CRITIQUE / B13    | impeccable on desk+money+withdraw → fix P0 only             |
| 3     | B-CMDK                 | ⌘K / global search **or** written waiver in residual        |
| 4     | B3                     | Deep uc craft = desk tokens/components                      |
| 5     | B4 / B5 / B9 remainder | per residual priority                                       |
| 6     | ADMIN-0                | inventory only, separate worktree                           |

## Every product PR

```bash
export SLICE_TYPE=CRAFT   # or HONESTY
export SLICE_ID=my-slice
mkdir -p docs/refs/$SLICE_ID && cp docs/refs/_template/* docs/refs/$SLICE_ID/
# fill gap-audit, steal-lines (craft), critique (craft)
pnpm frontend:preflight:craft    # or preflight with SLICE_TYPE
# implement → brand-scan → Orca → CI → Class N merge
# update residual-register.json status fields same turn
```

PR body: paste structure from `docs/FRONTEND-STREAM-A-PR-BODY.md`.

## Forbidden busywork

role=alert-only · token renames without Orca · “improved” without scorecard · touch order-route/futures · re-plan from zero · Nitro as runner

## Nitro only

Palette re-pick · taste “ours” · go-live money · Class X

## Queue truth (re-stamp when residual changes — cold agents)

| Done on tip                                                                | Still open AFK-safe (do next, no ask)                                                                                          | Parked (do not stall)                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Wave A/B desk craft · B4/B5 · B12 Partner/About · CMDK trap · residual AOS | **AFK-INVITE** → Envelope → Ctc → Activity → uc-comp → Lab pass → Index → CMDK routes → HelpDetail → WhitePaper · see residual | Auth money Orca · B11 · C-LWC · P0.4 SEGV (optional) |
| AFK campaign doc on tip                                                    | Drain `afk_safe` until empty                                                                                                   | B15 waived                                           |

**AFK:** `docs/FRONTEND-AFK-AUTONOMOUS-CAMPAIGN-2026-08-02.md` + prompt AFK block.  
**Do not re-plan from zero.** `pnpm frontend:residual` is the queue. Nitro only for palette/taste/Class X.
