# LANE STOP — L12 MATCHING · wave 7 · 2026-08-09

```
LANE: L12 wave 7
shipped: (tip-pending) #1351 cancel no longer invents never-traded market — live + journal replay + HTTP door
in flight: #1351 Class N CI seal blocked by sibling svc-protocol onchain (Shehzad), not matching
parked: fiat vs INTACORE dual-target product-complete (Denon L6) · §13 gRPC transport (contracts PR) · SnapshotSink push (matching+events, WS park)
Nitro must decide: none
SAFE TO CLOSE: no — wait #1351 merge when tip Tests not red on protocol lending oracle
tip: d40dff94
```

## Unit cards this cook

### A0 / A1 — cancel invent market (Class N)

| Field           | Value                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Promise         | Cancel must not create a market that never traded (depth already used `existingBook`; cancel used `book()`)                        |
| Reachable break | `engine.cancel(ghost, id)` → empty book stored → `GET /markets` lists ghost; journal cancel-only lines re-open phantoms on recover |
| Done bar        | Unknown market → not cancelled, no journal, no store; replay of cancel-only → no market; HTTP DELETE → 404 without invent          |
| Paths           | `services/svc-matching/src/engine/engine.ts` · `journal.ts` · tests · `router.test.ts`                                             |
| Collision       | #1351 (this PR) · Denon open files: none matching · L03 trade: no path intersect                                                   |
| Proof           | Local **134** matching tests green; CI Tests red only on `svc-protocol` lending oracle                                             |

### A1 — book integrity

| Field   | Value                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Promise | Price-time FIFO · cancel-oldest STP · maker price · no structural house preference beyond accepted law |
| Status  | **HOLDS** — 54 book tests green this cook; no residual break found                                     |

### A2 — public doors

| Field       | Value                                    |
| ----------- | ---------------------------------------- |
| Depth       | **PROVED** earlier + re-verified         |
| Cancel HTTP | **PINNED** this cook (404, no invent)    |
| Write auth  | **HOLDS** router service-credential pins |

### A2 — path-intersect L03 trade

No dual-write. Open trade PRs do not touch `services/svc-matching/**`. Matching remains engine-only; trade holds ledger.

### A3 — dual-target product law

**PARKED** L6 — fiat vs INTACORE dual-target product-complete is Denon invent-risk. Residual honesty only; do not ship product-complete engines.

## Engine A scorecard

| Prio | Unit                          | Status                                                    |
| ---- | ----------------------------- | --------------------------------------------------------- |
| A0   | Open matching PR merge        | **in flight** #1351 — craft done; CI seal sibling-blocked |
| A1   | cancel invent market residual | **DONE** in #1351 (live + replay + door)                  |
| A1   | book integrity residual       | **HOLDS** — no new residual                               |
| A2   | promise-falsify public doors  | **DONE** cancel door + depth holds                        |
| A2   | path-intersect L03 trade      | **CLEAR** — no dual-write                                 |
| A3   | fiat/INTACORE dual-target     | **PARKED** Denon L6                                       |
| A3   | stop note                     | **this file**                                             |
| A3   | Engine B pass                 | **below**                                                 |

## Engine B — promise falsification

| Chapter                                  | Status                                  |
| ---------------------------------------- | --------------------------------------- |
| Cancel unknown market invents book       | **FIXED** #1351 live                    |
| Cancel invent survives journal replay    | **FIXED** #1351 `replay` / `replayFrom` |
| Cancel HTTP invents market               | **PINNED** #1351                        |
| Depth invents market                     | **HOLDS** (prior)                       |
| Price-time / FIFO                        | **HOLDS** book.test                     |
| Cancel-oldest STP / no self-fill         | **HOLDS** book.test                     |
| Maker price                              | **HOLDS** book.test                     |
| Post-only / FOK / IOC / market remainder | **HOLDS** book.test                     |
| Journal-first + §5.4 determinism         | **HOLDS** engine.test                   |
| Dual-write trade                         | **FENCED** — not this wall              |

## Engine C — attack surface

| Surface                                   | Status                         |
| ----------------------------------------- | ------------------------------ |
| Invent market via cancel / depth / replay | **CLOSED** end-to-end in #1351 |
| Dual-write trade                          | **FENCED**                     |
| Denon dual-target product-complete        | **PARKED**                     |

## CI honesty

- Matching suite: **134 passed** locally on tip-based branch `723585d1`.
- GitHub Tests on #1351 failed once on **`@intafaced/svc-protocol`** `lending-oracle.onchain.test.ts` (debt `0n` vs `20 WAD`) — Shehzad S-A12/S-A4. L12 does not patch protocol.
- Prior stale head also failed on sibling pay fixture (gone after rebase); current blocker is protocol onchain.

## What Nitro sees

- One open matching PR: [#1351](https://github.com/Phantom-X-007/intafaced/pull/1351) — cancel cannot invent a never-traded market.
- Nothing else for Nitro to decide on this wall.
- Lane closes for craft when #1351 is on tip; seal waits on tip Tests not red for protocol.
