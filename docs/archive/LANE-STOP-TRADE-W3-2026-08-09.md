# LANE STOP — TRADE wave 3 · 2026-08-09

**Tip at writing:** re-derive with `git log -1 --oneline origin/main` (wave landed through **#1204** funding-rate bound; **#1207** reconcile job if present on tip).  
**Lane:** trade + matching residual · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only (not greenfield theatre).

Companion harvest: [`TRADE-LANE-HARVEST-2026-08-08.md`](./TRADE-LANE-HARVEST-2026-08-08.md) · prior stop: [`BUILD-STOP-TRADE-2026-08-08.md`](./BUILD-STOP-TRADE-2026-08-08.md) · Engine B: [`TRADE-PROMISE-FALSIFY-W3-2026-08-09.md`](./TRADE-PROMISE-FALSIFY-W3-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for residual product + Engine B money seals that agents can land without inventing owner numbers.

Engine A T1 residual is **shipped or parked owner-only**. Engine B falsify top 10: **8 sealed on main**, 1 owner socket, 1 transport seal in flight or sealed by non-implementation.

---

## Tip ritual (session start)

| Item                                       | Result                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Paste-time tip                             | `10886103`                                                                      |
| Futures claim `trade.futures @nitro-agent` | **Ghost cleared** — tip `ready` / no owner; no live futures PR holding the path |
| #1145 TWAP overdue ADR                     | **Merged** first — product blocker for scheduler mount                          |

---

## Merged this wave (named)

| PR        | What a trader / operator can now rely on                                                    | Class |
| --------- | ------------------------------------------------------------------------------------------- | ----- |
| **#1145** | Law: paused TWAP must not resume as a burst — interval is the promise                       | docs  |
| **#1183** | `convertQuote` refuses a shut venue (same hours gate as place)                              | P     |
| **#1182** | Tracker / LIVE-LANES / copy “profit share” lies corrected; falsify harvest on disk          | docs  |
| **#1193** | TWAP re-space + cancel atomicity + scheduler **default OFF**                                | **M** |
| **#1191** | Copy fee-share cap holds under concurrent settle; exposure RMW sealed; **still unmounted**  | **M** |
| **#1190** | Options listing refused until settlement fixing configured; half-list CHECK                 | P     |
| **#1199** | Redelivered leader fill no longer mirrors twice (`fillId` claim)                            | **M** |
| **#1202** | Funding membership frozen on first plan — open-after-period not charged on replay           | **M** |
| **#1203** | Insurance shortfall balance-checked; underfunded → park, no silent overdraw                 | **M** |
| **#1204** | Unbounded funding rate refused without inventing Denon ceiling — env max abs or fail-closed | **M** |
| **#1207** | Scheduled engine↔ledger reconcile job **default OFF**; refuse = alert only                  | **M** |

---

## Engine A scoreboard (after wave 3)

| Prio | Unit                       | Disposition                                                                                          |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| T0   | Clear futures claim        | **Done** — free on tip                                                                               |
| T1   | trade.otc residual         | **Park owner** — stake/§8/last-look sealed; `socket.otc-mid-feed` needs owner max-age                |
| T1   | trade.copy residual        | **Money sealed, still unmounted** — #1191 + #1199; routes not wired (correct until deliberate mount) |
| T1   | trade.mm-bot residual      | **Sealed** on tip (#1165 size/age); production mid ops residual                                      |
| T1   | venue.aggregation residual | **#1148** second venue on tip; scoring fabric present                                                |
| T2   | trade.algo residual        | **#1193** — create works; jobs OFF by design until ops enable                                        |
| T2   | trade.ccxt-api residual    | Prior seals (paper flag, 501s, hours); tracker note honest                                           |
| T2   | ws.gateway / web.terminal  | **Not this wave’s code** — shell `feedLive` residual; path-intersect **#1175** (other lane)          |
| T3   | futures residual           | Funding + insurance + membership sealed; margin-call transport / D3 ladder numbers remain            |
| T3   | forex thin                 | Hours on convert **#1183**; listing refuse **#1169**; fundable rails still Nitro/D8                  |
| T3   | options thin               | **#1190** refuse until fixing; **no IV model**; D7 still blocks product                              |

---

## Engine B — falsify top 10 after wave 3

| #   | Unit                                    | Status                                                    |
| --- | --------------------------------------- | --------------------------------------------------------- |
| 1–3 | TWAP respace / cancel / job mount OFF   | **Sealed #1193**                                          |
| 4   | Funding rate absolute bound             | **Sealed #1204** (operator sets max; no invented default) |
| 5   | Funding period membership               | **Sealed #1202**                                          |
| 6   | Copy fee-share reserve-then-post        | **Sealed #1191**                                          |
| 7   | OTC mid age                             | **Owner socket** — do not invent max-age                  |
| 8   | Engine↔ledger scheduled reconcile       | **Sealed #1207**                                          |
| 9   | Margin-call transport + grace non-start | **Sealed #1211** (stub notify; no grace without delivery) |
| 10  | Insurance shortfall bound               | **Sealed #1203**                                          |

Full claim register: [`TRADE-PROMISE-FALSIFY-W3-2026-08-09.md`](./TRADE-PROMISE-FALSIFY-W3-2026-08-09.md).

---

## Only Nitro / Denon (unchanged blockers)

### Nitro

- **N1** `TRADE_FUTURES_PROFIT_SOURCE` capitalisation
- **N2** product confirmation of max leverage (code may already enforce 10× — re-derive before board)
- **N3–N6** paper listing policy, rate-limit contract, FX listed-while-unfundable, `EDGE_TRUST_PROXY`
- Production venue API keys / live mid ops
- OTC commercial spreads / stake mins / mid max-age
- Copy **leader_share_bps** when mounting

### Denon

- **D1–D6** maintenance ladder numbers, funding product ceiling value, liq params, insurance fund **policy**, ADL, dark horizon
- **D7** options settlement fixing source
- **D8** forex settlement law
- **D9–D12** OTC sizes, copy scope/period, tier ladder authority
- **D13** resolved by **#1145** (interval is the promise)

---

## Deliberately not done (honest)

1. **Copy module still unmounted** — money races sealed; mount is a separate Class M PR with adversarial pass on routes.
2. **TWAP scheduler default OFF** — correct until ops enable `TRADE_ALGO_JOBS_ENABLED`; principal durability still SOCKET §13 (no mint).
3. **VWAP/POV** — still market maturity, not “no volume series”.
4. **web.terminal feedLive / decimal desk** — shell residual; do not dual-edit #1175 paths without path-intersect.
5. **OTC live mid with age** — owner max-age required.

---

## Machine / method

- Worktrees under `~/projects/sovereign-worktrees/feat-trade-*`
- Class M bodies + adversarial notes on money PRs
- Local DB suites may skip; **CI is the seal**
- Parallel: multi-stream harvest → unit cards → PR → merge greens continuously

---

## SAFE TO CLOSE?

**Yes — for wave 3 residual engines as scoped.**

Nothing left that is both (a) agent-doable without inventing product law and (b) a known live money break on mounted paths, except optional polish (margin-call transport test seal, copy mount when deliberately ordered).

**Next human glance:** Nitro N1/N2/N5; Denon D2 _number_ (mechanism fails closed without it) and D7 if options product wanted.

**Re-open lane when:** copy mount ordered · TWAP jobs enabled in an environment · margin-call product numbers arrive · shell terminal residual claimed free of #1175.
