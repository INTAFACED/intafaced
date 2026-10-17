> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# AFK residual STOP — 2026-08-07 (overnight)

**Tip at stop:** `5ede426f` — `fix(notify): the new claim lease acked the margin call it was meant to protect (#1037)`  
**Open Nitro PRs:** none (re-derived).  
**Reason to stop:** no open Nitro PR · overnight queue O1–O7 Stage residual landable on tip · no further agent-landable product strand without human/Denon numbers or Class X.

## Landed this overnight wave (re-derive git, not chat)

| PR          | What                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| #1021–#1029 | Prior wave still on tip (bank loan, money guards, pay step5, affiliates B, p2p late, …) |
| #1030       | notify.channels availability honesty (out-of-app switch)                                |
| #1031       | futures funding skips distinct from zero-rate settle (ADR §5)                           |
| #1032       | admin warehouse analytics surface (honest empty/lag)                                    |
| #1033       | notify delivery claim lease (mid-send double-send guard)                                |
| #1034       | futures `margin_current` tracks funding (mega-audit Tier 1 #3)                          |
| #1035       | notify unconfirmed target code honesty                                                  |
| #1036       | this STOP note (then tip-bumped)                                                        |
| #1037       | claim lease `in_flight` must retry (not ack) — closes #1033 hole                        |

## Overnight queue disposition

| ID                       | Disposition                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1 pay.public-api Step 5 | **On tip** (#1024 merchant quickstart + OpenAPI)                                                                                                                                             |
| O2 affiliates Slice B    | **On tip** (#1027 accruals). Slice C payout stays refuse-closed until §8                                                                                                                     |
| O3 futures wire residual | **On tip:** skip record (#1031), margin_current (#1034), caller-price refuse + payout-bound mechanism already present. **Not agent:** live rate oracle / 8h host; invent leverage max number |
| O4 p2p after disputes    | **On tip** (#1028 late settlements). Admin dispute console / Class X content remain human                                                                                                    |
| O5 ops.analytics deepen  | **On tip** (#1032 admin surface). Live ETL/warehouse wiring not agent-done                                                                                                                   |
| O6 money/doctrine guards | **On tip** (#1033 lease, #1034 margin_current, prior #1018/#1019). Leverage **max number** not inventable without DIRECTION/doctrine source                                                  |
| O7 hygiene               | Worktree GC applied (31 safe trees). Thrift deleted on tip (correct)                                                                                                                         |

## Human-only leftovers (do not agent-fake)

1. **Class X** — gateway credentials, prod go-live, secrets, sanctions content
2. **DIRECTION §8** — rates, fee shares, jurisdiction lists; affiliate **Slice C payout**
3. **Shehzad** — Protocol Plane / INTACHAIN / chain mountains (babysit only)
4. **Futures leverage cap number** — mega-audit cites “doctrine 10×”; definitive build does not state a number agents may invent. Denon/DIRECTION must name the max before wire.
5. **FE / shell** — if product FE remains locked to vendored shell craft rules
6. **Live oracles** — funding rate feed, warehouse replica ETL, out-of-app notify gateways

## Re-open when

- Denon names leverage max (or market-level caps) · §8 rates for affiliate payout · Class X credentials · new ADR “agents may implement” Stage residual · open PR to babysit

**Do not** restart from free-list alone or tip-bump honesty mills.
