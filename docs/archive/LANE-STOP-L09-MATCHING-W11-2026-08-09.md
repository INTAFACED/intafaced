# LANE STOP — L09 MATCHING · wave 11 · product-velocity · 2026-08-09

```
LANE: L09 wave 11 product-velocity
shipped: #1611 trigger-rejected stop burns one sequence (the cancel), not two
in flight: none
parked: Class M crash mid-emit re-publish (recover emits nothing by design; outbox / trade redelivery) · §13 multi-replica journal / Redis SnapshotSink / gRPC · cancel-reason bus field (packages/events one-writer) · fiat/INTACORE dual-target (Denon L6)
Nitro must decide: none
SAFE TO CLOSE: yes
tip: 7200dba5
```

## What shipped (plain words)

| PR                                                            | What                                                                                                                                | Class | Proof                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- |
| [#1611](https://github.com/Phantom-X-007/intafaced/pull/1611) | A post-only stop-limit that fails viability on activation no longer invents a free sequence — cancel and outcome share one sequence | N     | MERGED `7200dba5`; matching **145** tests; CI Tests green after tip rebase |

## Unit card (shipped)

| Field           | Value                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Promise         | README / `submit()`: rejections decide viability **before** `nextSequence`; rejected path must not invent free sequences (audit M2)    |
| Reachable break | `activate()` took seq for “activation”, then another for `trigger_rejected` → cancel.seq ≠ outcome.seq; counter +2 for a non-fill path |
| Done bar        | cancel.sequence === outcome.sequence; aggressor+cancel accounting `before + 3`; depth.sequence tracks; RED→GREEN pin in `book.test.ts` |
| Paths           | `services/svc-matching/src/engine/book.ts` · `book.test.ts`                                                                            |
| Collision       | claim-check clear; open matching PRs: 0 at start                                                                                       |

## Seals re-verified this cook (tip + #1611 suite)

| Seal                                         | Status                                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| #1351 cancel invent (live + replay + HTTP)   | **HOLDS** — engine + router pins green                 |
| #1520 reject invent + truncated decode       | **HOLDS** — engine + journal.test                      |
| #1552 FileJournal clean rewrite after torn   | **HOLDS** — journal.test rewrite/append                |
| Public doors (depth / cancel / list / recon) | **HOLDS**                                              |
| Path-intersect trade dual-write              | **FENCED** — this wall only `services/svc-matching/**` |

## Engine A scorecard

| Prio | Unit                             | Status                                         |
| ---- | -------------------------------- | ---------------------------------------------- |
| A0   | Open matching PR merge           | none open at start                             |
| A1   | cancel invent residual           | **empty** — #1351 holds                        |
| A1   | journal truncated residual       | **empty** — #1520 + #1552 hold                 |
| A1   | Class M crash mid-emit residual  | **PARK** — pick-up below (not matching invent) |
| A1   | trigger-reject sequence residual | **DONE** #1611 (audit M2)                      |
| A2   | public door residual             | **empty**                                      |
| A2   | path-intersect trade             | **CLEAR** — no dual-write                      |
| A3   | §13 multi-replica / gRPC / sink  | **PARK** L6                                    |
| A3   | reject invent residual           | **empty** — #1520 holds                        |
| A3   | Engine B + stop note             | **this file**                                  |

## Engine B — promise falsification

| Chapter   | Verdict                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| cancel    | invent closed live + replay + HTTP (#1351)                                           |
| journal   | truncated decode boots (#1520); post-boot rewrite clean (#1552); short write refused |
| HTTP door | S2S writes; depth/cancel/list honesty; reconcile refuse matrix holds                 |
| sequence  | pure reject leaves counter; trigger-reject burns **one** cancel seq (#1611)          |

## Engine C — attack surface

| Threat                | Status                                    |
| --------------------- | ----------------------------------------- |
| invent market         | sealed (cancel + reject + depth + replay) |
| truncated journal lie | sealed (#1520 + #1552)                    |
| free sequence invent  | sealed (#1611)                            |
| dual-write trade      | fenced                                    |
| crash mid-emit gap    | **documented park** — not invent residual |

## Parks (not pad)

- **Crash mid-emit / recover re-publish** — book+journal commit, then sequential bus publish; recovery rebuilds books and **emits nothing** (avoids double `tradeFill`). Matching-only re-emit without durable outbox is forbidden by design. Pick-up: `packages/events` outbox or trade redelivery/reconcile (**not this wall**).
- **§13 multi-replica journal / Redis SnapshotSink / gRPC** — SOCKET product-complete L6 / contracts PR.
- **Cancel reason on bus** — catalog field in `packages/events` (one-writer fence).
- **Trade reconcile job wiring** — trade wall.
- **Fiat vs INTACORE dual-target product-complete** — Denon invent-risk L6.

## CI honesty

- Local matching suite: **145 passed** (pre-push) · typecheck clean · `pnpm gates` 36/36.
- First CI Tests red on **sibling** `svc-protocol` lending-oracle (Shehzad fence) — not matching. Rebased onto tip; Tests **green**; merged.
- Matching craft never dual-edited protocol.

## Path wall

Exclusive: `services/svc-matching/**`  
Fenced: trade dual-write · invent multi-replica journal · Shehzad #1177 implement · HUMAN frontend.
