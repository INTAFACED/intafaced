# LANE STOP — L11 NOTIFY + alerts · wave 10 product-velocity · 2026-08-09

**Lane wall:** `services/svc-notify/**`  
**Tip at write:** `0731f404` (includes #1586).  
**SAFE TO CLOSE:** **yes** — product L1–P3 residual craft empty after tip re-derive; only Nitro Class X / undecided product-law parks remain.

---

## Packet (plain)

```
LANE: L11 wave 10 product-velocity
shipped:
  · A0 open notify PR merge — none on wall at start
  · #1586 price watches fire from trade public ticker (TRADE_URL)
       mid when two-sided · last fallback · unset stays dark
       same surface svc-bank already uses for loan marks
  · Engine B README chapter pass — all HOLD on tip after #1586
  · RAN-IT: svc-notify 39 suites / 303 tests pass · 36 doctrine gates green
in flight: none
parked:
  · gateway credentials Class X — docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md
  · 429 not-before — only if ops measures thrash
  · non-EN alert i18n — OS EN catalog only
  · operator fleet delivery list — needs admin scope product law
  · more bus consumers — optional / product law undecided
  · digest cadence — deliberately unwired (pin)
  · position.updated beyond liquidated — undecided product law
  · §31 phase-5 funding / whale / mobile sync — other modules / invent-risk
Nitro must decide: gateway credentials Class X if out-of-app must go live
SAFE TO CLOSE: yes
tip: 0731f404
```

---

## Engine A — units this wave

| Unit                    | Done bar                                      | Status            | Proof                                                            |
| ----------------------- | --------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| A0 open notify PR merge | green or none                                 | **none open**     | claim-check clear at start                                       |
| A1 v22.alerts mark feed | watches can fire without inventing a price    | **SHIPPED #1586** | `createTradeHttpMarkSource` + TRADE_URL; dark default when unset |
| A1 ops.notifications    | event-driven fan-out honest channels (in-app) | **SEALED core**   | prior W6–W9; OOA still Class X                                   |
| A1 multi-replica SMS    | no N× free codes                              | **SEALED**        | W7–W9 re-verify                                                  |
| A1 reaper / stuck       | no fake delivered forever                     | **SEALED**        | W7–W9                                                            |
| A2 kill residual        | honest                                        | **SEALED**        | #1521 + pins                                                     |
| A2 claim lease          | no double free SMS                            | **SEALED**        | #1521                                                            |
| A2 refusal matrix       | complete                                      | **SEALED**        | pins                                                             |
| A3 gateway credentials  | park Class X                                  | **PARK Class X**  | owner action doc                                                 |
| A3 Engine B pass        | stop note                                     | **this file**     | below                                                            |

**Anti-pad:** one product PR only. No re-pin theater of sealed residual. Tracker mountain stays `ready` (OOA Class X blocks `done`).

---

## Engine B — chapter pass (README → code on tip after #1586)

| Chapter                            | Verdict                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| The one thing (attempt ≠ accepted) | **hold** — CHECK + settle                                                              |
| Channels                           | **hold** — four adapters; unconfigured refuse; required fatal staging/prod             |
| Addresses                          | **hold** — own targets; verify-through-channel; multi-replica rates                    |
| API                                | **hold** — full tRPC; self-only; deliveries user-facing; mount.reachable               |
| Events                             | **hold** — 10 consumers = matrix; Class B pin                                          |
| Reaper                             | **hold** — arm1 attempts_exhausted · arm2 delivery_stuck                               |
| Price alerts                       | **hold** — sweep mounted; TRADE_URL live factory; dark when unset; disclosure canFire  |
| Kill-switches                      | **hold** — fanout no-write; OOA named refuse                                           |
| Environment                        | **hold** — TRADE_URL optional blank-as-absent                                          |
| §13 sockets                        | **hold** — adapters real; gateways wait Class X; mark feed code-complete via TRADE_URL |

No new §8 invented. Digest stays unwired (pin).

---

## Engine C — attack surface

| Surface          | State                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Replica free SMS | **mitigated** — FOR UPDATE rates + lease                           |
| Fake delivered   | **mitigated** — accepted only on transport receipt + DB CHECK      |
| Kill lie         | **mitigated** — fanout off writes nothing; OOA named refuse        |
| Orphan events    | **mitigated** — Class B growth pin                                 |
| Dark gateway     | **mitigated** — typed refuse; zero send                            |
| Invented mark    | **mitigated** — dark default; live quotes refuse empty/down ticker |
| 429 thrash       | **parked** — retryable + attempt budget                            |

---

## RAN-IT this wave

Worktree `feat/w10-l11-alert-trade-mark` before merge:

```
pnpm exec turbo run build --filter=@intafaced/svc-notify...
cd services/svc-notify && pnpm exec vitest run
→ Test Files  39 passed | 4 skipped
→ Tests       303 passed | 46 skipped

pnpm gates → 36 doctrine gates green
CI on #1586 → all required checks pass → squash-merged
```

---

## Parked pick-up

1. Owner gateway URL/token (Class X) — [`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](./OWNER-ACTIONS-NOTIFY-GATEWAYS.md).
2. Optional 429 not-before if gateway thrash appears in ops.
3. Non-EN alert key translations when non-EN catalogs land.
4. Operator fleet delivery list — needs admin scope product law.
5. Optional wider `position.updated` statuses — product law undecided.
6. Phase-5 alert tiers (funding / whale / mobile) — other modules.

---

## Wall

`services/svc-notify/**` only. No dual-write. Class X credentials never invented.  
No packages/** craft this wave. No invent-risk product-complete engines.
