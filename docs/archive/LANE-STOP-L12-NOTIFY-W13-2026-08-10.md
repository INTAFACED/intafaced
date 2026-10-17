# LANE STOP — L12 NOTIFY + ops.notifications · wave 13 product-velocity ~2× · 2026-08-10

**Lane wall:** `services/svc-notify/**`  
**Tip at write:** `8978b2fd` (includes #1638).  
**SAFE TO CLOSE:** **yes** — product L1–P3 residual craft empty after #1638; only Nitro Class X / undecided product-law parks remain.

---

## Packet (plain)

```
LANE: L12 wave 13 product-velocity ~2x substance
shipped:
  · #1638 compose TRADE_URL for svc-notify — price watches can fire in the stack
       (same ticker bank already uses; unset still dark)
  · #1638 settle ownership by attempt — late gateway after reclaim cannot stamp accepted
  · #1638 claim never abandons under a live lease
  · #1638 boot-refusal spawnSync pin deleted (queue shrank)
  · #1586 ticker watches — HOLDS under tip
in flight: none
parked:
  · gateway credentials Class X — docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md
  · operator fleet delivery list — needs admin scope product law
  · digest cadence — deliberately unwired (pin)
  · position.updated beyond liquidated — undecided product law
  · §31 phase-5 funding / whale / mobile sync — other modules / invent-risk
Nitro must decide: gateway credentials Class X if out-of-app must go live
SAFE TO CLOSE: yes
tip: 8978b2fd
```

---

## Engine A — disposition (anti-pad)

| Prio | Unit                       | Done bar                           | Status                                      |
| ---- | -------------------------- | ---------------------------------- | ------------------------------------------- |
| A0   | Open notify PR merge       | green                              | **#1638 merged**                            |
| A1   | ops.notifications product  | event-driven fan-out honest        | **SEALED core** · OOA Class X residual      |
| A1   | v22.alerts product         | core + dark refuse + live when URL | **SEALED** #1586 + #1638 compose wire       |
| A1   | price watch residual       | #1586 holds                        | **HOLDS**                                   |
| A2   | multi-replica SMS residual | no N× free codes + settle own      | **SEALED** rate PG + #1638 settle ownership |
| A2   | reaper residual            | no fake delivered forever          | **SEALED** dual arm                         |
| A2   | kill residual              | honest                             | **SEALED** prior                            |
| A3   | gateway credentials        | park Class X                       | **PARK**                                    |
| A3   | mountain-event             | tracker honesty                    | **#1638 claim then clear to ready**         |
| A3   | Engine B pass              | stop note                          | **this file**                               |

**Anti-pad:** two real product Done bars only (compose mark live + settle ownership). No re-pin theater of sealed residual. Mountains stay non-`done` (OOA Class X).

---

## Engine B — promise falsification

| Chapter          | Verdict                                                               |
| ---------------- | --------------------------------------------------------------------- |
| Channels         | **hold** — four adapters; unconfigured refuse; required fatal staging |
| Alerts           | **hold** — TRADE_URL live factory; compose sets it; unset dark        |
| Reaper           | **hold** — arm1 attempts_exhausted · arm2 delivery_stuck              |
| Kill             | **hold** — fanout no-write; OOA named refuse                          |
| Fan-out / settle | **hold** — attempt ownership after reclaim; lease ≥ timeout (#1521)   |

No new §8. Digest stays unwired (pin).

---

## Engine C — attack surface

| Surface                     | State                                                           |
| --------------------------- | --------------------------------------------------------------- |
| Replica free SMS / codes    | **mitigated** — FOR UPDATE rates + claim lease + settle attempt |
| Fake delivered forever      | **mitigated** — accepted only on transport 2xx + DB CHECK       |
| Invented mark / silent live | **mitigated** — dark default; live only via factory + TRADE_URL |
| Dark gateway Class X        | **fenced** — not_configured refuse; owner doc                   |

---

## RAN-IT this wave

- Worktree `feat/w13-l12-notify-engine-b` @ tip base `64f4de79` → rebased → merged as #1638
- Local svc-notify: **307 passed** / 46 skipped (pre-merge)
- Local typecheck pin clean after spawnSync fix
- CI workflow_dispatch green (Typecheck · Tests · Doctrine · DoD) before merge
- PR path Tests once red on **unrelated** onchain lending flaky (`svc-protocol` oracle) — not notify wall
- Denon #1625–1627 path-intersect: **none** on `svc-notify`

---

## Nitro

Must decide: gateway credentials Class X if out-of-app must go live (`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`). Otherwise nothing.

SAFE TO CLOSE: **yes**
