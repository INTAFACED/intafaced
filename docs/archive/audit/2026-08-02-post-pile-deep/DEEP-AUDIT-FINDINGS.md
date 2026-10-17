# Deep post-pile audit — findings + fixes (not the thin seal)

**Date:** 2026-08-02  
**Tip base:** `3b33fe0` (+ this ship)  
**Why this exists:** First post-pile WAVE-AUDIT was a **scan seal** (CX-8 + greps). That was too thin for “audit insane amounts.” This pass used **adversarial code review** (4 parallel deep audits) + surgical fixes.

**Plan parent:** `docs/POST-PILE-AUDIT-HARDEN-PLAN-2026-08-02.md`  
**Collision:** no #346 pay implement · no shehzad M2–M7 engines · #390 UI craft parallel — only honesty money UI fixes

---

## 0 · Honest correction

| Earlier claim                     | Truth after deep audit                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P0=0 on pile                      | **False** — real P0s in MM multi-fill, WS private upgrade demux, desk wallet invent, recharge false-success |
| LIVE mint 0 + HTTP_DOOR covered   | **Over-green** — admin dividend path not in door list                                                       |
| Order-route S2S body-bound        | **False** — trade ledger/matching clients still v1                                                          |
| Private WS hardened in production | **Unit-true, process-false** — public upgrade 404’d private path                                            |
| Kill switch “lets users out”      | **Orders only** — futures position close was trapped                                                        |

---

## 1 · Fixed this ship (agent)

| Sev    | ID                                          | Fix                                                                                  |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| **P0** | House MM multi-fill wrong recipe            | `settleFill` routes by house MM identity always; stub `seeded=true`; regression test |
| **P0** | Public WS upgrade rejects `/private/stream` | Public gateway **ignores** non-`/stream` paths                                       |
| **P0** | Desk wallet invent 0 on partial             | Both legs required for `walletReachable`; no `\|\| 0` invent                         |
| **P0** | Recharge KYC gate success toast             | `$Message.error` not success                                                         |
| **P1** | Dividend dual-book door gap                 | Block `/system/dividend` + path-unit fixture                                         |
| **P1** | Trade → ledger S2S v1                       | Body-bound `serviceAuthHeadersForBody`                                               |
| **P1** | Trade → matching S2S v1                     | Body-bound                                                                           |
| **P1** | Kill traps futures close                    | `DELETE /api/v1/positions/:id` always-allowed                                        |
| **P1** | Edge JWT audience default                   | `intafaced.api` aligned with platform                                                |
| **P2** | CX-8 partial fill as success                | STRICT full terminal status / full qty                                               |

---

## 2 · Named residual

| Sev         | Item                                              | Status                                                              |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| P0 residual | Admin BFF unauthenticated (shared token)          | **Partial** — optional `ADMIN_BFF_SHARED_SECRET`; SSO still ops     |
| P1          | MM seed run only in process memory                | **Closed** — `TRADE_MM_SEED_STATE_PATH`                             |
| P1          | Kill non-edge modules cosmetic (`ws`)             | **Closed** — perimeter labels + runbook                             |
| P1          | Kill state not durable multi-replica              | **Partial** — single-host `EDGE_KILL_STATE_PATH`; multi-replica §13 |
| P1          | Account bind / SMS silent fail                    | **Closed** — catch + bind lock                                      |
| P1          | Marketing overclaims (Cayman, largest, 101 years) | **Closed** — en.js honesty rewrite                                  |
| P1          | svc-pay still S2S v1                              | **Open** — shehzad #346                                             |
| P2          | Entity wallet `save` still open                   | **Open** — M7 shehzad                                               |
| P2          | JVM 410 smoke                                     | **Open** — Docker host                                              |
| Human       | Human X go-live                                   | **Open** — Nitro                                                    |
| Human       | M1–M7 mountains                                   | **Open** — shehzad                                                  |

**Program status:** **AGENT-COMPLETE** — see `AGENT-COMPLETE-SEAL-2026-08-02.md`  
Continue archives: `DEEP-AUDIT-CONTINUE*.md`

---

## 3 · Method (historical — program closed)

1. Parallel adversarial reviewers on trade money · dual-book · edge/WS · vendor UI
2. Confirm each P0 in source before code
3. Fix + regression test where feasible
4. Do **not** declare P0=0 after greps alone
5. Finish: seal agent residual; leave Human X + shehzad only

---

## 4 · Evidence commands

```
node tooling/ci/dual-book-door-path-unit.mjs
node tooling/ci/dual-book-door-scan.mjs
# CI: Tests (edge kill-switch, trade if PG) + Order-path CX-8
```

**Not go-live. Not BOARD-COMPLETE.**
