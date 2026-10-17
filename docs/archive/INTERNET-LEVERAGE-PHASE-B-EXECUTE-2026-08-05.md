# Internet leverage — Phase B execute (post-gate)

**Status:** COMPLETE · research map only (no implement)  
**Stamp:** 2026-08-05 · tip re-derived at execute  
**Phase A gate:** **PASS** — CURRENT-AUDIT refreshed same program (svc-support, D-S-01…18, open PRs, FUTURE breadth, tip drift)  
**Plan:** hardened [`INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md`](INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md)  
**Decision surface:** [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md) (re-derived this stamp)  
**Evidence body:** v2 tables still valid — [`INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md)  
**Methodology:** [`INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md`](INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md)

**Non-regression:** shell = product UI · ledger-client = only book · no dual-kit · no invent mids.

---

## 0 · Operator one-screen

### What this is

Full Phase B **after** Phase A proper. **Not** “only five levers.” Ranking = **start order**.

### Tier A — start without inventing product law

| #   | Track                          | Path             | Why                               |
| --- | ------------------------------ | ---------------- | --------------------------------- |
| 1   | RE2 (re2js / node-re2)         | EXT              | ReDoS; Denon finding class        |
| 2   | Gitleaks CI                    | EXT              | SECURITY-WHEN-PLAIN still missing |
| 3   | Depth E2E prove + decimal desk | IN               | Phase A G-P0-1/2                  |
| 4   | Human P2P dispute path         | GF + LAW         | Your ruling; D-S-08               |
| 5   | Denon #428 land + D-S factory  | IN/LAW           | Unblocks engines                  |
| 6   | Pay residual after #346        | IN (+ EXT later) | S-PAY first                       |

### Tier B — after law / thin vertical

Hyperswitch trial · SimpleWebAuthn · Moov ACH libs · KYC adapters (X) · notify SDKs · trade.\* after D-S · wallet RPC review → MPC class (X)

### Tier C — late

Mobile · analytics warehouse · SigNoz · chain S stack · VR/stream · PayFac depth

### Tier Z — never

Second UI kit · second ledger SoT · invent mids · Kleros Fiat adjudicator · unaudited mainnet custody · CCXT money · Nitro L1 · dual-edit open human PRs

### You decide (X / product)

PSPs · issuers · KYC vendors · custody SaaS · audit hire · mobile yes/no · fund Denon law time

---

## 1 · B0 — Gap backlog (from green Phase A)

| GapID      | Need               | Phase A                 | Owner | Lanes       |
| ---------- | ------------------ | ----------------------- | ----- | ----------- |
| G-P0-1     | Depth E2E residual | Client #748; prove live | N     | L-UI IN     |
| G-P0-2     | Decimal desk       | Wire bignumber          | N     | L-UI IN     |
| G-P0-3     | Pay residual       | After #346              | N     | L-PAY       |
| G-P0-4     | Denon open (#428)  | His                     | D     | —           |
| G-P0-5     | Engine law         | D-S-01…05               | D     | L-MATCH LAW |
| G-P1-4     | Wallet review      | V-WALLET-RPC            | D     | L-CUSTODY   |
| G-P1-5     | Support wire       | svc-support             | N     | L-OPS IN    |
| G-SEC      | ReDoS + secrets CI | Named                   | N/D   | L-SEC       |
| P2P-D      | Human disputes     | Ruling                  | N/D   | L-P2P       |
| FUT-\*     | All tracker open   | §5 Phase A              | N/D/S | by domain   |
| FUT-CHAIN  | L1                 | S board                 | S     | L-CHAIN-REF |
| FUT-MOBILE | App                | No kit source           | N     | L-MOBILE    |

**Open PRs collision:** #428 Denon — no dual-edit · #346 Shehzad pay — path-check residual only.

**Prior terrain imported:** ORDER-ROUTE (exchange-core STUDY/KILL replace; fast-check Tier A; toxiproxy later; CCXT money KILL) · SECURITY-WHEN-PLAIN (gitleaks Track A).

---

## 2 · B1 — Lanes

| Lane        | Owner | Active?                                           |
| ----------- | ----- | ------------------------------------------------- |
| L-UI        | N     | IN first; EXT validation lib MID                  |
| L-PAY       | N     | EXT Hyperswitch trial MID                         |
| L-BANK      | N     | EXT Moov libs MID                                 |
| L-P2P       | N/D   | GF desk + EXT RE2                                 |
| L-ID        | N     | EXT SimpleWebAuthn + KYC adapters                 |
| L-MSG       | N     | EXT provider SDKs                                 |
| L-DATA      | N     | LATE search/warehouse                             |
| L-OBS       | N/D   | IN keep OTEL; LATE SigNoz                         |
| L-SEC       | N/D   | **NOW** RE2 + Gitleaks                            |
| L-CUSTODY   | D→N   | Review then EXT                                   |
| L-MATCH     | D     | IN S-MATCH; STUDY only externals                  |
| L-CHAIN-REF | S     | REF only                                          |
| L-MOBILE    | N     | LATE                                              |
| L-AGENTS    | N     | IN svc-agents; EXT frameworks only if needed LATE |
| L-ACADEMY   | N     | IN; EXT N/A default                               |
| L-OPS       | N     | IN; ticket SaaS later                             |
| L-TOKEN     | N     | IN honesty; no EXT invent economics               |
| L-TEST      | N/D   | EXT fast-check MID; toxiproxy LATE                |
| L-I18N      | N     | IN packages/i18n; TMS LATE if needed              |
| L-KILL      | —     | Always                                            |

---

## 3 · B2/B3 — Research summary (evidence in v2)

Full raw/kill tables: **v2 report** (multi-source web + `gh api` metadata + X sample + last30days attempt disclosed thin).

**This execute does not re-fake community pulse.** Shortlist confirmed against tip gate:

| Keep / trial                | License / push (prior API)  | Kill examples                   |
| --------------------------- | --------------------------- | ------------------------------- |
| re2js / node-re2            | MIT / BSD · active          | length-cap-only                 |
| Gitleaks                    | MIT · ~28k★                 | random secret SaaS pack default |
| Hyperswitch                 | Apache-2.0 · ~43k★ · active | balance-SoT gateways            |
| SimpleWebAuthn              | MIT                         | full self-host KYC now          |
| Moov ACH family             | Apache-2.0                  | guaranteed APY OSS              |
| Human dispute GF            | —                           | Kleros Fiat; TON bots           |
| dYdX v4 / CometBFT / Cosmos | REF S                       | Nitro L1; Hyperliquid binary    |
| DFNS/Turnkey later          | SaaS X                      | hot-wallet npm                  |
| fast-check                  | prior landscape             | —                               |
| exchange-core               | stale 2023                  | replace matching                |
| Formance/TigerBeetle        | MIT/etc                     | replace ledger                  |

---

## 4 · B4 — Deep cards (shortlist) — unchanged conclusions

1. **RE2** — cost 1/5 · pure safety · N/D
2. **Gitleaks** — cost 1/5 · CI · N
3. **Hyperswitch** — cost 3/5 · adapter only · ledger SoT · N + X keys
4. **SimpleWebAuthn** — cost 2/5 · N
5. **Moov ACH libs** — cost 2/5 · N + D-S-09
6. **Human dispute desk** — GF · N/D
7. **Wallet RPC review → MPC** — D then N + X
8. **Chain ref pack** — S only

---

## 5 · B5 — Weights

30% severity · 25% doctrine · 20% cost↓ · 15% maturity · 10% multi-unlock → same Top order as Tier A/B above.

---

## 6 · B6 — Full-horizon

Canonical table: **FULL-HORIZON doc** — **89/89 tracker IDs as named rows** (done-done, no wildcards). Non-tracker gaps in §3 of that doc.

---

## 7 · Hole hunt (execute)

| Q                 | A                             |
| ----------------- | ----------------------------- |
| Phase A gate?     | Pass after refresh            |
| Max-5 ceiling?    | Removed from plan + messaging |
| svc-support?      | In Phase A + L-OPS            |
| #748?             | Reflected as E2E residual     |
| Dual-edit #428?   | Forbidden                     |
| Second ledger/UI? | Kill                          |
| last30days rich?  | No — disclosed; web+gh used   |
| All lanes?        | Yes or N/A                    |

---

## 8 · Completeness checklist (plan §6/§7)

- [x] Phase A green at B0
- [x] Full-horizon every open need
- [x] Kill ≥ shortlist
- [x] No dual-kit/book
- [x] Rank = order only
- [x] Class X separate
- [x] S isolated
- [x] Prior terrain imported
- [x] Open PRs noted
- [x] No implement
- [x] Non-regression restated
- [x] Methodology self-check

---

## 9 · Non-claims

Did not npm-install. Did not merge adopt code. Did not close Class X. Did not invent D-S product numbers.

---

_Board-Delta: Phase B execute post Phase A proper gate — full-horizon + Tier start order_

---

## Denon alignment (2026-08-05)

- **Hyperswitch:** KILL / refused D-S-10 ADR #769 (not §0.6; orchestrator + Doctrine 5).
- **ReDoS:** prefer pure-JS linear matchers; native node-re2 costed out on money-adjacent services.
- **Depth E2E:** proven (not residual).
- **Human dispute desk:** built/in-flight (not GF-pending).
- **Wallet RPC:** NOW critical defects (#763 freeze; unfixed).
- **Test DB:** per-branch isolation required beyond file dual-edit ban.
- **D-S board:** 18 done per Denon.
