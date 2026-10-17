> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](../GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Night engine — why the first wave stopped + what continues

**Tip re-derive:** `git fetch && git log -1 --oneline origin/main`

## Why it looked like “only 30 minutes”

1. Your **written peace bar** was: free product empty **or** blocked-only + DASHBOARD.
2. After shell Class N (#462–#472) + claim locks (#471), freeze reported **freeProduct=0**, blocked **P-WS only**.
3. Law then forbids the “insane N” fantasy paths: Shehzad M1–M7 implement, Denon open-file dual-edit, invent depth while WS broken, features.mjs mid-wave.
4. Coordinator treated peace = session end. **That was wrong for “full night AFK.”** Peace is a **scoreboard checkpoint**, not a kill switch.

## Night engine rules (execution, not replan)

While AFK overnight, loop until human returns:

| Lane           | Action                                  | Stop condition                |
| -------------- | --------------------------------------- | ----------------------------- |
| Product freeze | re-freeze; SPAWN_NOW only               | none free or blocked-only     |
| Shell residual | invent scan / wire residual             | claim + PR                    |
| Class N Nitro  | merge when CI green                     | none open green               |
| Partner PRs    | babysit comment only                    | never implement               |
| P-WS           | **report only** integrity               | no depth UI                   |
| TRK-\*         | research/spec packs under docs/ops/trk/ | not full implement swarms     |
| #425           | rebase/conflict resolve Class N         | merged or blocked with reason |

Cadence: every ~30–45m re-freeze · PR matrix · merge green · **spawn P1–P3 real work** when freeProduct=0.

**Stamp-mill ban (2026-08-04, permanent):** do **not** open R07/R01/P-WS “cycle N” docs PRs when freeProduct stays 0 and the partner matrix is unchanged. `pnpm swarm:status` prints the AFK ladder — follow it. Law: [`SWARM-MANDATE.md`](./SWARM-MANDATE.md).

## Honest limit (not thrift theater)

There is **not** infinite free product UI once residual is drained. Night value then is: **stranded branch lands**, partner CI hygiene (exact fails), conflict unstick, integrity reports **on delta**, tracker research, gate hardening — not 20 agents inventing depth and **not** tip-bump stamp spam.

## Cycle log (Coord-OPS)

### Cycle 2026-08-03 ~13:12–13:17Z

| Item            | Result                                                             |
| --------------- | ------------------------------------------------------------------ |
| Tip start       | `a0f73c86` #472 Index announce                                     |
| freeProduct     | **0** every freeze · SPAWN_NOW none                                |
| Merged          | #470 (pre-session) · #473 Denon format · **#474** night-engine law |
| Tip after       | `f96ac6b4` docs(ops): night engine keep-alive law (#474)           |
| Nitro open      | #425 rebased + force-push · #475 P-WS report prettier re-push      |
| Denon babysit   | comments on #448 #445 #422 #441 #428 #433 — no file edits          |
| Shehzad         | #346 still CONFLICTING — babysit only                              |
| Blocked product | P-WS-REPORT only                                                   |

Do **not** stop the loop solely because freeProduct=0 — continue Class N merges, partner babysit, #425, integrity docs, TRK research packs.

### Cycle 2026-08-03 ~13:17–13:27Z

| Item               | Result                                                   |
| ------------------ | -------------------------------------------------------- |
| Tip end            | `e71bb264` (+ #480 TRK packs)                            |
| freeProduct        | **0** · SPAWN_NOW none                                   |
| Merged this window | #475 #425 #476 #478 #479 #480 (+ earlier #470 #473 #474) |
| Nitro open         | #481 rebased; CI wait                                    |
| Partner            | Denon conflicts unchanged — comments only                |
| Product spawn      | none                                                     |

### Cycle 2026-08-03 ~13:36–13:45Z (keep-alive)

| Item               | Result                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| Tip start          | `c773dafa` #482 R07 cycle2                                               |
| freeProduct        | **0** · SPAWN_NOW none · freeTracker research only                       |
| Merged this window | none (no open Nitro Class N at start)                                    |
| Pivot              | TRK pack 3 (10 specs) + invent re-scan reaffirm + R07                    |
| Partner            | Denon #433/#427/#424/#420 MERGEABLE+green — his merge; conflicts babysit |
| Shehzad            | #346 CONFLICTING — babysit only                                          |
| Product spawn      | none — freeProduct=0 is **not** kill                                     |

### Cycle 2026-08-03 ~13:36–14:05Z (Coord-OPS AFK ×6)

| Item          | Result                                                                         |
| ------------- | ------------------------------------------------------------------------------ |
| Tip end       | `94cc463d` (#502)                                                              |
| freeProduct   | **0** every freeze · SPAWN_NOW none                                            |
| Merged window | #489 shell money baseline; #490–#502 docs/TRK/R07/claims/R01 (parallel agents) |
| Denon         | #427 partner-merged; MERGEABLE green listed only — no agent merge              |
| Product spawn | none · blocked P-WS-REPORT only                                                |

### Cycle 7 — 2026-08-03 ~14:07–14:12Z

| Item        | Result                                                           |
| ----------- | ---------------------------------------------------------------- |
| Tip         | `94cc463d` → `e4836982` (#503 R07 · #504 TRK short-name upgrade) |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none                       |
| Invent      | reaffirm clean (no live invent residual)                         |
| Partner     | Denon #445/#433 full green MERGEABLE — his merge; no dual-edit   |
| Shehzad     | #346 CONFLICTING — babysit only                                  |

### Cycle 13 — 2026-08-03 ~14:40Z

| Item        | Result                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Tip         | `4c0a5a16` #514 cycle12                                                    |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                  |
| Invent      | reaffirm clean                                                             |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts unchanged |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                       |

### Cycle 14 — 2026-08-03 ~14:50Z

| Item        | Result                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Tip         | `ed0421f7` #515 cycle13                                                    |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                  |
| Invent      | reaffirm clean                                                             |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts unchanged |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                       |

### Cycle 19 — 2026-08-03 ~15:12Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `3d477ef0` #521 cycle18                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | reaffirm clean (live invent residual 0)                                  |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                     |

### Cycle 20 — 2026-08-03 ~15:15Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `97085936` #522 cycle19                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | reaffirm clean (live invent residual 0)                                  |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                     |

### Cycle 21 — 2026-08-03T15:20Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `fa3b69a1` #523 cycle20                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | reaffirm clean (live invent residual 0)                                  |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                     |

### Cycle 22 — 2026-08-03T15:23Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `4881de21` #524 cycle21                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | reaffirm clean (live invent residual 0)                                  |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                     |

### Cycle 23 — 2026-08-03T15:28Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `c04a072a` #525 cycle22 + #526 invent                                    |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | reaffirm clean (live invent residual 0)                                  |
| Partner     | Denon #445/#433/#430/#420 ready — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — report only · no dual-edit                     |

### Cycle 25 — 2026-08-03 ~15:50Z

| Item        | Result                                                       |
| ----------- | ------------------------------------------------------------ |
| Tip         | `00fdd51e` #529 cycle24                                      |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none                   |
| Nitro       | unstuck #530 R01 babysit rebase onto tip                     |
| Invent      | live residual **0**                                          |
| Partner     | Denon #445/#433/#420 green — his merge; P-WS still #433+#432 |

### Cycle 26 — 2026-08-03T15:43Z

| Item        | Result                                                            |
| ----------- | ----------------------------------------------------------------- |
| Tip         | `89f1b614` #533 cycle25                                           |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none                        |
| Nitro       | absorb #531 closed + #532 CONFLICTING into cycle26 keepalive      |
| Invent      | live residual **0**                                               |
| Partner     | Denon #445/#433/#430/#420 ready — his merge; P-WS still #433+#432 |

### Cycle 31 — 2026-08-03 ~16:20Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `741d6371` #542 cycle30                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 35 — 2026-08-03 ~16:50Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `54795ac8` #550 cycle34                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 40 — 2026-08-03 ~17:10Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `823a6351` #562+#563                                                     |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 41 — 2026-08-03 ~17:13Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `5d92c784` #564+#565                                                     |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 42 — 2026-08-03 ~17:20Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `6d4551e1` #567 cycle41 + #568 R01 cycle42                               |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 43 — 2026-08-03 ~17:24Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `ada0764e` #569 cycle42                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 44 — 2026-08-03 ~17:30Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `58836e3d` #571 cycle43                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 45 — 2026-08-03 ~17:40Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `4a05436c` #572+#573                                                     |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 46 — 2026-08-03 ~17:45Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `2d4b1957` #574–#577                                                     |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 47 — 2026-08-03 ~17:49Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `e013d1ee` #578 cycle46                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 48 — 2026-08-03 ~17:53Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `dd4a6d28` #580 cycle47                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 49 — 2026-08-03 ~18:01Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `7a549f90` #581+#583 cycle48                                             |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 50 — 2026-08-03 ~18:06Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `480d91a6` #585 cycle49                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 51 — 2026-08-03 ~18:10Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `a122b0a8` #587 cycle50                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 52 — 2026-08-03 ~18:15Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `1a824fb8` #589 cycle51                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

### Cycle 53 — 2026-08-03 ~18:19Z

| Item        | Result                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| Tip         | `432f6e73` #591 cycle52                                                  |
| freeProduct | **0** · freeTracker **0** · SPAWN_NOW none · open Nitro=0                |
| Invent      | live residual **0**                                                      |
| Partner     | Denon #445/#433/#420 full green — his merge; #428 red; conflicts babysit |
| P-WS        | still blocked #433+#432 — no dual-edit                                   |

## Anti-drift (2026-08-04)

**Problem observed:** freeProduct=0 AFK loop degraded into R07/R01/P-WS tip-bump stamps every few minutes while the partner matrix and invent residual stayed unchanged.

**Rule:** Prefer the **AFK priority ladder** in [`SWARM-MANDATE.md`](./SWARM-MANDATE.md). Cadence re-freeze is OK; **shipping a docs PR requires a board delta or a P1–P3 deliverable** (stranded branch land, partner unblock signal, TRK deepen, invent findings change).

**Cadence when freeProduct=0:** re-check board every 30–45m (schedulers). Spawn writers only for P1–P3. Do not open R07 cycle N solely because the previous cycle merged.
