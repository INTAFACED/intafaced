# LANE STOP — L04 MATCHING · wave 9 · 2026-08-09

```
LANE: L04 MATCHING wave 9
shipped: #1552 journal cleans a truncated tail before the next append (FileJournal rewrite + short-write refuse)
in flight: none
parked: Class M crash mid-emit re-publish (recover intentionally emits nothing; outbox/trade redelivery) · §13 multi-replica journal / Redis SnapshotSink / gRPC · trade-owned reconcile job caller · fiat/INTACORE dual-target (Denon L6)
Nitro must decide: none
SAFE TO CLOSE: yes
tip: 32537f69
```

## What shipped (plain words)

| PR                                                            | What                                                                                                                                                 | Class | Proof                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| [#1552](https://github.com/Phantom-X-007/intafaced/pull/1552) | After a crash leaves a torn last journal line, boot rewrites the clean records before any new append; a short write no longer pretends to be durable | N     | MERGED `32537f69`; local **144** matching tests; CI Tests green after rebase |

## Seals re-verified this cook (tip)

| Seal                                             | Status                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| #1351 cancel invent (live + replay + HTTP)       | **HOLDS**                                                                    |
| #1520 reject invent + decode truncated tail      | **HOLDS**; #1552 completes the **operational** FileJournal seal after decode |
| Public doors (depth / cancel / list / reconcile) | **HOLDS** — S2S writes; depth/cancel no invent                               |
| Path-intersect trade dual-write                  | **FENCED** — this wall only `services/svc-matching/**`; no trade dual-write  |

## Engine A scorecard

| Prio | Unit                                    | Status                                      |
| ---- | --------------------------------------- | ------------------------------------------- |
| A0   | Open matching PR merge                  | none open at start; #1552 shipped this cook |
| A1   | cancel invent residual                  | **empty** — #1351 holds                     |
| A1   | reject invent residual                  | **empty** — #1520 holds                     |
| A1   | journal truncated tail residual         | **done** — #1520 decode + #1552 rewrite     |
| A2   | Class M crash mid-emit residual         | **PARK** — pick-up below                    |
| A2   | public door residual                    | **empty**                                   |
| A2   | path-intersect trade                    | **CLEAR** — no dual-write                   |
| A3   | §13 multi-replica / SnapshotSink / gRPC | **PARK** L6                                 |
| A3   | Engine B pass + stop note               | **this file**                               |

## Engine B — promise falsification

| Chapter   | Verdict                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| cancel    | invent closed live + replay + HTTP (#1351)                                                   |
| reject    | virgin FOK/structural invent closed live + replay (#1520)                                    |
| journal   | truncated decode boots (#1520); post-boot append stays bootable (#1552); short write refused |
| HTTP door | auth S2S on writes; depth/cancel/list honesty; reconcile refuses money-strand cases          |

## Engine C — attack surface

| Threat                | Status                                    |
| --------------------- | ----------------------------------------- |
| invent market         | sealed (cancel + reject + depth + replay) |
| truncated journal lie | sealed end-to-end (#1520 + #1552)         |
| dual-write trade      | fenced                                    |
| crash mid-emit gap    | **documented park** — not invent residual |

## Parks (not pad)

- **Crash mid-emit / recover re-publish** — book+journal commit, then sequential bus publish; recovery rebuilds books and **emits nothing** (avoids double `tradeFill`). Matching-only re-emit without durable outbox is forbidden by design. Pick-up: packages/events outbox or trade redelivery/reconcile (not this wall).
- **§13 multi-replica journal / Redis SnapshotSink / gRPC** — SOCKET product-complete L6 / contracts PR.
- **Trade reconcile job wiring** — trade wall.
- **Fiat vs INTACORE dual-target product-complete** — Denon invent-risk L6.

## Unit card this cook (shipped)

| Field           | Value                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Promise         | Crash mid-write last line is non-durable; recovery boots; journal remains a complete NDJSON log (`journal.ts` / #1520)  |
| Reachable break | Truncated open left partial bytes; next append glued; later boot dropped a real record or threw mid-file corruption     |
| Done bar        | Truncated → open → append → re-open → seqs match; raw body has no partial residue; failed append does not grow `length` |
| Class           | N                                                                                                                       |
| Paths           | `services/svc-matching/src/engine/journal.ts` · `journal.test.ts`                                                       |
| Collision       | claim-check clear at open; open matching PRs: 0                                                                         |

## CI honesty

- Matching suite: **144 passed** locally on branch tip after rebase.
- First CI Tests red on **sibling** `svc-protocol` lending-oracle (Shehzad) — not matching; L04 did not dual-edit protocol.
- Rebase onto tip + re-run: Tests **green**; PR merged.

## Path wall

Exclusive: `services/svc-matching/**`  
Fenced: trade dual-write · invent multi-replica journal without law · Shehzad #1177 implement · HUMAN frontend.
