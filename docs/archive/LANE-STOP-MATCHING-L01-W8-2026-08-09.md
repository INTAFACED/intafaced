# LANE STOP — L01 MATCHING · wave 8 · 2026-08-09

```
LANE: L01 MATCHING wave 8
shipped: #1351 cancel no longer invents a never-traded market · #1520 reject invent closed + journal boots past a truncated tail
in flight: none
parked: Class M crash mid-emit re-publish (recover intentionally emits nothing; trade redelivery/idempotency) · §13 multi-replica journal / Redis SnapshotSink · gRPC transport · trade-owned reconcile job caller
Nitro must decide: none
SAFE TO CLOSE: yes
tip: 4de07fb0
```

## What shipped (plain words)

| PR                                                            | What                                                                                                                                                                                    | Class | Proof                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------- |
| [#1351](https://github.com/Phantom-X-007/intafaced/pull/1351) | Cancel of a never-traded market does not create a book, journal line, or list entry; legacy cancel-only journal lines do not re-open markets; HTTP DELETE returns 404 without inventing | N     | MERGED `e0fec75e`; matching 134→142 suite               |
| [#1520](https://github.com/Phantom-X-007/intafaced/pull/1520) | A rejected first submit (FOK / invalid qty) does not leave a never-traded market; replay same; truncated last journal line no longer kills boot                                         | N     | MERGED `4de07fb0`; local **142 passed**; CI Tests green |

## Engine A scorecard

| Prio | Unit                                                                 | Status                                                            |
| ---- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A0   | Merge #1351 cancel invent                                            | **done**                                                          |
| A1   | cancel invent residual under change                                  | **empty** after #1351                                             |
| A1   | journal replay residual (cancel-only + reject-only + truncated tail) | **done** #1351+#1520                                              |
| A2   | public HTTP door residual                                            | **empty** — depth/cancel/reject inherit engine honesty            |
| A2   | book integrity residual                                              | **empty** — PTP/STP/zero-qty covered; no illegal house preference |
| A3   | path-intersect trade                                                 | **held** — no dual-write                                          |
| A3   | fiat vs INTACORE product-complete                                    | **park Denon** L6                                                 |
| A3   | stop note                                                            | **this file**                                                     |

## Engine B chapters

| Chapter        | Verdict                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| cancel         | invent closed live + replay + HTTP                                           |
| journal        | cancel-only phantoms fixed; reject-only phantoms fixed; truncated tail boots |
| HTTP door      | auth S2S on writes; depth public no invent; DELETE 404 no invent             |
| book integrity | no CLEAR L1–L4 break beyond accepted law                                     |

## Engine C attack surface

| Threat            | Status                                    |
| ----------------- | ----------------------------------------- |
| invent market     | sealed (cancel + reject + depth + replay) |
| dual-write trade  | fenced; not touched                       |
| protocol dual-fix | fenced; not touched                       |

## Parks (not pad)

- **Crash mid-emit / recover re-publish** — documented intentional: recovery rebuilds books, does not re-emit. Outbox/trade redelivery is Class M / trade wall, not matching invent residual.
- **§13 multi-replica journal / Redis snapshot / gRPC** — SOCKET product-complete L6.
- **Trade reconcile job wiring** — trade wall.

## CI notes this wave

- Prior #1351 red was **svc-protocol** lending-oracle (Shehzad); rebased onto green tip, merged.
- #1520 mid-flight reds were **sibling flakes** (notify vitest worker timeout; p2p linear-pattern 5s timeout) — matching always 142 green; not dual-fixed.

## Path wall

Exclusive: `services/svc-matching/**`  
Denon open at start: #1502 (ci gates) · #1494 (support) — no intersect.
