# Post-pile WAVE-AUDIT · 02 findings (adversarial)

**Method:** live tip re-derive · dual-book classify + door scan + path unit · brand scan · invent/mid/kill greps · MM mid-source review · CX-8 **workflow_dispatch on main** · scoreboard honesty check  
**Builder ≠ grader:** findings from tip state, not PR author notes.

---

## Verdict

| Severity                                          | Count | Action this wave |
| ------------------------------------------------- | ----: | ---------------- |
| **P0** (money invent / doctrine break / CX-8 red) | **0** | —                |
| **P1** (false peace / stale SoT / merge risk)     | **3** | Docs honesty PR  |
| **P2** (known residual / human / deepen optional) | **6** | Named only       |

**Empty P0 is success** — not a reason to invent code.

---

## P0 — none

Re-checks that would have been P0 if red:

| Check                            | Result             | Proof                                                                                                               |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Dual-book LIVE mint count        | **0**              | `dual-book-setbalance-classify.mjs` → LIVE total 0                                                                  |
| Door interceptor registration    | **clean**          | `dual-book-door-scan.mjs`                                                                                           |
| Door path unit                   | **clean**          | 39 fragments                                                                                                        |
| Brand names                      | **clean**          | brand-scan 913 files                                                                                                |
| MM mid invent                    | **fail-closed**    | `mid-source.ts` / seed-planner refuse null/empty/`0`                                                                |
| Candle / venue / MM seed default | **OFF** unless env | `env.ts` defaults                                                                                                   |
| CX-8 on **main** tip after #381  | **SUCCESS**        | [run 30734772090](https://github.com/Phantom-X-007/intafaced/actions/runs/30734772090) L3_LEDGER_OK + IDEMPOTENT_OK |

Ledger after fill (main CX-8): buyer BTC `0`→`0.0998`, seller USDT `0`→`9.99` (fees honest, not invent full qty).

---

## P1 — fix this wave (docs honesty)

| ID         | Finding                                                         | Why it matters                                    | Fix                                          |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| **F-P1-1** | `docs/LIVE-LANES.md` still describes 2026-07-30 overnight lanes | Cold agents claim dead lanes / wrong Do-not-touch | Reset to tip reality + post-pile claim       |
| **F-P1-2** | Board Clear scoreboard tip stuck at `#370` / `8644d4f`          | Hides #380 L3+L4 seal                             | Stamp tip + order-route proof #380           |
| **F-P1-3** | NEXT still “BABYSIT-HUMAN only” without post-pile seal pointer  | Agents re-enter invent spray                      | Point to WAVE-AUDIT complete + residual list |

---

## P2 — named residual (do not fake closed)

| ID         | Finding                                      | Owner            | Notes                                                                                                                  |
| ---------- | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **F-P2-1** | HTTP_DOOR 14 Java setBalance bodies remain   | shehzad **M7**   | Door 410 + path unit cover; optional method-entry polish                                                               |
| **F-P2-2** | Dual-book ≠ JVM prod boot proof              | Ops / M7         | Host often no Docker                                                                                                   |
| **F-P2-3** | Human X (secrets, fleet, kill drill, go-yes) | **Nitro**        | `ORDER-ROUTE-HUMAN-X-PRODUCTION-CLAIM`                                                                                 |
| **F-P2-4** | Board M1–M7 OPEN (#346 dirty)                | **shehzad**      | Agents babysit only                                                                                                    |
| **F-P2-5** | B-WS-2 live futures position E2E             | M3 + agent later | §13 until correct events                                                                                               |
| **F-P2-6** | `TRADE_SPOT_ENABLED` defaults **true**       | Ops posture      | Documented kill-switch; chaos F7 proves cancel-on-kill. Not invent money. Prod Human X must set posture intentionally. |

---

## Explicit non-findings (checked, clean)

- No MM invent mid on empty config
- No candle invent empty markets
- No CX-8 invent fill on timeout (STRICT)
- WS positions tests “no invent” when silent
- Brand / partner names clean

---

## Code PRs this wave

**None required** for P0. Optional future: F-P2-6 runbook line already in OPS kill docs — no code change without product decision.
