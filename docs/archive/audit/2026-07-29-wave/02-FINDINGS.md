# Mega-wave findings — tip `27ce1d4` · since `60031cf`

**Method:** parallel L1–L9 on delta + pre-merge #101. No full A–E archaeology.

## Verdict

**Keep building. Not go-live.** No P0 free-mint / open withdraw IDOR / mount-dead money surface on main tip. Highest residual is **P1 integrity/auth** on new token + convert + WebAuthn paths (fixed on this branch — see PEACE).

---

## P0 — none on tip

---

## P1 (delta) — fix or block

| ID                 | Title                                                                      | Status this PR                                                       |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **M-01**           | Stake claim: same stakeId, different amount/user still posts caller amount | **FIXED** — conflict check like pay.deposit                          |
| **M-02**           | Optional stakeId + pending hidden → orphan/double lock on crash            | **MITIGATED** — pending visible in get/list all; conflict-safe retry |
| **M-03**           | Convert maxAvgPrice not bound into market-buy protection                   | **FIXED** — maxProtectionPrice on placeOrder                         |
| **L2-TOKEN-JURIS** | token stake/unstake/vote skip jurisdiction matrix                          | **FIXED** — `{ module: 'token' }`                                    |
| **L2-WA-UV**       | WebAuthn passwordless UV preferred + flag not checked                      | **FIXED** — required + UV flag                                       |

## P2 (parked with reason)

| ID                    | Title                                                      | Why park                                         |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| M-04                  | Unstake ledger-first → ghost active until retry            | Retry heals via ledger key; claim-unstaking next |
| M-05                  | Convert house spread not booked                            | Product economics, not theft                     |
| M-06                  | Withdraw rail re-ask needs rail idempotency                | Design residual; adapters                        |
| L2-IDOR-STAKE         | stakeOf/accessOf free userId                               | **FIXED** self-only on interactive               |
| L2-IDOR-RANK          | rank.get free userId                                       | Not in this PR; still open                       |
| L2-WA-CHALLENGE-STORE | In-process WebAuthn challenges                             | HA only                                          |
| L7-WS-INGEST-MEM      | TradeHub ingest no market allowlist                        | DoS if bus compromised                           |
| F-L9-1                | MiningsJob still credits shell wallet                      | Dual-book residual                               |
| F-L9-2                | Live DAO increaseBalance\* remain                          | Dual-book residual                               |
| PR101-P1              | Screening empty outside staging/prod; edge-only boot guard | Ops / counsel                                    |

## P3

M-07 mintEpoch txn holds across ledger · M-08 (addressed by self-only) · L2-WA-ENUM · L2-UNSTAKE-SVC · L2-WA-STEPUP-TOTP-ONLY · F-L9-3/4/5 docs/nginx/verify gap

---

## CLEAN (judged)

- Convert bigint math; convert uses same hold/IOC path
- Stake recipes purpose-keyed; mint admin+MFA; governance no ledger money
- Pay deposit claim-before-book; withdraw principal-only; merchant ownership
- Protocol AMM: no ledger-client; unsigned calldata only
- WS trade tape: public prints; order IDs stripped
- Mounts: pay/protocol/token/trade/identity registered + edge routes
- #96: unfreezeMore/TRUNCATE/CORS\* claims **hold** (not theater)
- #101: dex.quote fail-closed, no ccxt, screening provenance holds → **safe to merge** (not sanctions content done)

---

## Pre-merge open PRs

| PR                              | Verdict                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| **#101** Denon verified release | **Safe to merge** engineering; counsel still owns list content |
| **#102** trading hours          | Money path — owner merge; prove order-create calls gate        |

---

## #96 residual scoreboard update

| Residual #               | Item                                                  | After this wave           |
| ------------------------ | ----------------------------------------------------- | ------------------------- |
| 2 CORS \*+credentials    | **CLOSED on main** (#96)                              | remove from open residual |
| 3 unfreezeMore           | **CLOSED** (throw + no-op)                            | remove                    |
| 4 dropWeekTable TRUNCATE | **CLOSED**                                            | remove                    |
| 1 dual-book              | **OPEN** — MiningsJob + DAO mutators remain           | keep                      |
| 14 sanctions content     | **MECHANISM improved in #101**; content still counsel | keep                      |
