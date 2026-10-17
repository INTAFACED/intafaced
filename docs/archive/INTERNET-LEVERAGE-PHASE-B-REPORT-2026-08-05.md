# Internet leverage — Phase B report (external candidates) — v1 historical

**Status:** SUPERSEDED · do not use for decisions  
**Superseded by:** [`INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md)  
**Why:** v1 was thin (narrow fan-out, missed prior SECURITY/ORDER-ROUTE terrain, weak kill list, no methodology audit). v2 is the all-out gap-first report.

**Date:** 2026-08-05 (v1)  
**Tip at research:** re-derive `origin/main`  
**Plan law:** [`INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md`](INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md)  
**Phase A:** [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md)  
**Term:** Internet leverage = already-built systems we adopt/wire/wrap instead of rebuild.

---

> **Operators:** read **v2 only**. Body below is historical for PR #772 audit trail.

---

**Non-regression (Phase A):** vendor shell = sole product UI · `ledger-client` = only book · no second full exchange kit · no Java dual-book.

---

## 0 · Operator one-screen (read this first)

|  Rank | Candidate                                                   | Gap it fills                          | Owner                      | Action                                                                  |
| ----: | ----------------------------------------------------------- | ------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| **1** | **Hyperswitch** (Juspay, Apache-2.0)                        | Pay orchestration / multi-PSP routing | **N** (+ Class X keys)     | **Trial** — adapter behind `svc-pay`; never replace ledger              |
| **2** | **re2 / RE2-class regex** (Google RE2 / re2js)              | ReDoS (Denon measurement)             | **N/D**                    | **Adopt** in hot parsers (P2P method strings, etc.)                     |
| **3** | **Kleros** (dispute protocol, refs)                         | On-chain dispute **reference** only   | **S** (optional later)     | **Later / reject for Fiat P2P** — Fiat disputes = human (your ruling)   |
| **4** | **CometBFT + Cosmos SDK + dYdX v4 CLOB pattern**            | INTACHAIN P1 sequencing               | **S**                      | **Reference pack for Shehzad** (matches doctrine §17) — not Nitro build |
| **5** | **DFNS / similar MPC APIs** (or self-host MPC after review) | Custody beyond unaudited wallet_rpc   | **D** review → **N** adapt | **Later** after security review; **not** drop-in second book            |

**Your decisions (if any):**

- **Class X:** which PSPs/issuers to enable once Hyperswitch-class adapter exists.
- **Custody:** fund security review of in-tree wallet RPC **before** any MPC vendor.
- **Do not** adopt another full exchange UI kit.

---

## 1 · B0 — Gap backlog (research anchors)

| GapID      | Need                           | Phase A status        | Owner   | Research lanes             |
| ---------- | ------------------------------ | --------------------- | ------- | -------------------------- |
| G-P0-1     | Live depth client              | **Done** #748 + fleet | —       | _closed_                   |
| G-P0-3     | Pay residual after handoff     | Handoff asserted      | N       | L-PAY                      |
| G-P0-4     | Denon money PR land            | His pile              | D       | _(no external — land PRs)_ |
| G-P0-5     | Engine product law             | D-S-\* pending        | D       | L-MATCH (libs only)        |
| G-P1-1     | OTC/admin workflows            | Kit under-used        | N       | L-UI (reject dual-kit)     |
| G-P1-4     | Wallet RPC live                | Review-first          | D       | L-CUSTODY                  |
| P2P-D      | Human disputes + ReDoS + erase | Rulings sent          | N/D     | L-P2P, L-SEC               |
| FUT-BANK   | Bank earn/cards/ramps          | Reclaimed             | N       | L-BANK, L-PAY              |
| FUT-ID     | KYC adapters                   | Residual              | N       | L-ID                       |
| FUT-MSG    | Notify providers               | Residual              | N       | L-MSG                      |
| FUT-MOBILE | Mobile                         | Kit stubs only        | N later | L-MOBILE                   |
| FUT-CHAIN  | L1 path                        | Shehzad board         | S       | L-CHAIN-REF                |
| G-OBS      | Ops scale                      | OTEL present          | N/D     | L-OBS                      |

---

## 2 · B1 — Lane map

| Lane        | In                                      | Out                      | Owner tag          |
| ----------- | --------------------------------------- | ------------------------ | ------------------ |
| L-UI        | Components that **complement** shell    | Full exchange SPA        | N (frontend claim) |
| L-PAY       | Orchestration / connector libs          | Second ledger            | N                  |
| L-BANK      | Yield/card adapter patterns             | Guaranteed APY products  | N + D law          |
| L-P2P       | Moderation/dispute **tooling patterns** | Auto-adjudicate disputes | N/D                |
| L-ID        | KYC/WebAuthn **adapters**               | Sanctions list content   | N + Class X        |
| L-MSG       | Email/SMS/push SDKs                     | —                        | N                  |
| L-DATA      | Indexer/search                          | Invent market data       | N                  |
| L-OBS       | Metrics/logs beyond stock otel          | —                        | N/D                |
| L-SEC       | ReDoS-safe regex, secret scan           | —                        | N/D                |
| L-CUSTODY   | MPC/HSM vendors                         | Dual-book wallets        | D then N           |
| L-MATCH     | Perf libraries                          | Price/oracle invent      | D seal             |
| L-CHAIN-REF | Cosmos/CLOB refs                        | Nitro implementing L1    | S only             |
| L-MOBILE    | RN/Flutter stacks                       | Now                      | Later              |
| L-KILL      | Explicit rejects                        | —                        | —                  |

---

## 3 · B2/B3 — Candidates (raw → keep/kill)

### L-PAY

| Candidate                                      | License          | Keep?                               | Reason                                                                                     |
| ---------------------------------------------- | ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| **Hyperswitch**                                | Apache-2.0       | **KEEP**                            | Mature open orchestration; 100s of connectors; self-host; maps to pay.routing/psp residual |
| Moov / similar open ACH                        | varies           | later                               | US-rail heavy; useful later for ramps                                                      |
| “Build only Stripe SDK”                        | proprietary SaaS | keep as **connector**, not platform | Adapter pattern already doctrine                                                           |
| Full OSS “payment gateway that holds balances” | various          | **KILL**                            | Second book risk                                                                           |

### L-SEC

| Candidate                         | Keep?    | Reason                                                         |
| --------------------------------- | -------- | -------------------------------------------------------------- |
| **Google RE2 / re2js / re2-wasm** | **KEEP** | Industry standard ReDoS-safe regex; answers Denon 8.9s finding |
| “Just raise length cap”           | **KILL** | Already disproven                                              |

### L-P2P

| Candidate                           | Keep?                        | Reason                                                                               |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| **Kleros**                          | **REF only / KILL for Fiat** | Decentralized jurors; conflicts with “human moderator + custody escrow” for Fiat OTC |
| Telegram/TON AI escrow bots         | **KILL**                     | Wrong platform; custody/trust model clash                                            |
| In-house dispute queue on tip specs | **KEEP (greenfield)**        | SPEC-OTC already defines Done; no good drop-in OSS moderator desk found              |

### L-CUSTODY

| Candidate                        | Keep?            | Reason                                          |
| -------------------------------- | ---------------- | ----------------------------------------------- |
| In-tree wallet RPC modules       | **REVIEW first** | Phase A: months saved but security precondition |
| DFNS / Fireblocks-class MPC APIs | **LATER**        | Strong ops; SaaS/keys = Class X; adapter-only   |
| Random “hot wallet npm”          | **KILL**         | Supply-chain + custody                          |

### L-CHAIN-REF (Shehzad pack)

| Candidate                          | Keep?                            | Reason                                             |
| ---------------------------------- | -------------------------------- | -------------------------------------------------- |
| **CometBFT**                       | **REF**                          | Doctrine §17 P1 stack                              |
| **Cosmos SDK + Cosmos EVM**        | **REF**                          | App-chain + EVM module path                        |
| **dYdX v4 CLOB-on-Cosmos pattern** | **REF**                          | Closest open precedent for on-chain CLOB app-chain |
| Hyperliquid architecture papers    | **REF only**                     | Closed/custom L1 — learn SLOs, don’t copy binary   |
| Random new L1 kits                 | **KILL** unless Shehzad proposes | Noise                                              |

### L-ID

| Candidate                                          | Keep?            | Reason                               |
| -------------------------------------------------- | ---------------- | ------------------------------------ |
| Stripe Identity / Persona / Sumsub **as adapters** | **LATER**        | Standard; interface already doctrine |
| Self-host full KYC stack                           | **KILL for now** | Ops/legal weight                     |

### L-MSG

| Candidate                              | Keep?     | Reason                            |
| -------------------------------------- | --------- | --------------------------------- |
| Provider SDKs (SES, Twilio, FCM, etc.) | **ADAPT** | Behind `svc-notify` ports already |
| Second notification platform           | **KILL**  | We have svc-notify                |

### L-UI

| Candidate                             | Keep?               | Reason                       |
| ------------------------------------- | ------------------- | ---------------------------- |
| Another full exchange front end       | **KILL**            | Phase A non-regression       |
| lightweight-charts (already in shell) | **KEEP (in-repo)**  | Already decided              |
| Headless a11y / focus libs            | **TRIAL if needed** | Only if frontend claim wants |

### L-OBS / L-DATA

| Candidate                                   | Keep?              | Reason                                      |
| ------------------------------------------- | ------------------ | ------------------------------------------- |
| Existing OTEL/Prometheus/Grafana in compose | **KEEP (in-repo)** | Don’t replace stack casually                |
| Meilisearch/Typesense for ops search        | **LATER**          | Only if ops.admin search becomes a mountain |
| ClickHouse for analytics                    | **LATER**          | Warehouse residual                          |

### L-MOBILE

| Candidate          | Keep?     | Reason                                                       |
| ------------------ | --------- | ------------------------------------------------------------ |
| Expo/RN or Flutter | **LATER** | Kit mobile stubs empty; not next 90 days unless product push |

### L-MATCH

| Candidate                        | Keep?              | Reason                                                |
| -------------------------------- | ------------------ | ----------------------------------------------------- |
| Generic matching-engine crates   | **LATER + D seal** | We have svc-matching; external only for perf research |
| “Open oracle mid feeds” as truth | **KILL**           | Invent/oracle doctrine                                |

### L-KILL (global)

- Second ledger / dual-book “leverage”
- Full UI kit replacement
- Auto-dispute AI as Fiat adjudicator (contradicts tip SPEC + your ruling)
- Unreviewed custody to mainnet

---

## 4 · B4 — Deep cards (shortlist)

### H1 · Hyperswitch

- **Job:** Unified payment intent + routing across PSPs without rewriting `svc-pay` each time.
- **Fit:** G-P0-3 / pay.routing / pay.psp residual.
- **Integration cost:** 3/5 (Rust stack + adapter layer; our ledger stays source of balances).
- **Doctrine:** OK if **adapters only** and ledger recipes for money.
- **Owner:** Nitro implement; Denon if routing product law needed.
- **Risk:** Ops complexity; don’t let it hold customer balances as system of record.

### H2 · RE2-family regex

- **Job:** Stop catastrophic backtracking on untrusted strings (P2P methods, admin inputs).
- **Fit:** Denon ReDoS finding + L-SEC.
- **Integration cost:** 1/5.
- **Doctrine:** Pure safety.
- **Owner:** Nitro/Denon on hot paths.
- **Risk:** API differences vs JS RegExp — wrap once.

### H3 · CometBFT / Cosmos SDK / dYdX v4 pattern (reference)

- **Job:** INTACHAIN P1 realism for Shehzad S-D\*.
- **Fit:** L-CHAIN-REF.
- **Integration cost:** N/A for Nitro (not our implement).
- **Owner:** **Shehzad only**.
- **Risk:** Hyperliquid-class perf is **not** copy-paste OSS — sequence P0 contracts first (doctrine).

### H4 · MPC custody vendor (DFNS-class) — later

- **Job:** Production key ceremony / policy engines after in-tree RPC review.
- **Fit:** G-P1-4.
- **Integration cost:** 4/5 + Class X.
- **Owner:** Denon security review → Nitro adapter.
- **Risk:** SaaS lock-in; never bypass ledger accounting for custodial plane.

### H5 · In-house dispute desk (greenfield on tip law)

- **Job:** list + evidence read + human resolve (your ruling).
- **Fit:** P2P-D.
- **Why not OSS:** No clean self-hosted moderator desk matched SPEC-OTC + custody escrow without wrong incentives (Kleros is chain-jury, not our Fiat human desk).
- **Owner:** Nitro implement after Denon lands #428-related honesty, or parallel if path-clear.

---

## 5 · B5 — Rank weights (stated)

| Weight | Factor                          |
| -----: | ------------------------------- |
|    30% | Gap severity                    |
|    25% | Doctrine/safety                 |
|    20% | Integration cost (lower better) |
|    15% | Maturity                        |
|    10% | Multi-mountain unlock           |

**Top 5 by that rubric:** Hyperswitch · RE2 · (greenfield dispute desk) · Cosmos/CLOB ref pack · MPC later.

---

## 6 · B6 — 90-day adopt queue (max 5 tracks)

| #   | Track                          | Days 0–30                                          | Days 30–60             | Days 60–90                     |
| --- | ------------------------------ | -------------------------------------------------- | ---------------------- | ------------------------------ |
| 1   | **RE2 on hot parsers**         | Spike wrap + one P2P path                          | Roll out               | Done bar: ReDoS suite          |
| 2   | **Hyperswitch spike**          | Compose trial, no ledger bypass                    | Design `PayRouterPort` | Thin vertical sandbox card/PSP |
| 3   | **P2P human dispute path**     | Spec already ruled — implement list/evidence/admin | Wire shell             | Timer not adjudicator          |
| 4   | **Wallet RPC security review** | Denon-led threat model                             | Fix or quarantine      | Only then live testnet         |
| 5   | **Shehzad CLOB-ref pack**      | S-D0 ADR cites CometBFT/dYdX pattern               | P0 contracts continue  | No Nitro L1 divert             |

**Not in 90 days:** mobile app, full analytics warehouse, replacing matching engine, Kleros for Fiat disputes.

---

## 7 · Kill list (proof of filtering)

| Rejected                                                   | Why                                               |
| ---------------------------------------------------------- | ------------------------------------------------- |
| Second full exchange front-end kit                         | Phase A non-regression                            |
| Any “open source exchange that includes balances as truth” | Dual-book                                         |
| Kleros as default Fiat dispute                             | Conflicts human-moderator + custody escrow ruling |
| TON/Telegram escrow bots                                   | Wrong trust/platform                              |
| Unmaintained hot-wallet npm                                | Custody supply chain                              |
| Oracle mid feeds as matching truth                         | Invent ban                                        |
| Self-host full KYC platform now                            | Legal/ops; use adapters later                     |

---

## 8 · Sources (sample; multi-source per active lane)

- Hyperswitch: GitHub juspay/hyperswitch; project docs (Apache-2.0 orchestration)
- Payments landscape: industry writeups comparing open orchestrators
- ReDoS: Google RE2 design; Denon in-repo measurement
- Disputes: Kleros docs (ref); tip `SPEC-OTC-RFQ-AND-EARN-2026-08-02.md`
- Chain: CometBFT GitHub; Cosmos SDK; dYdX v4 vs Hyperliquid architecture comparisons
- Phase A audit + Denon hard board + three-way ownership

---

## 9 · Completeness (plan §7)

- [x] Gap backlog from Phase A + boards
- [x] Lanes addressed or N/A
- [x] Multi-source research (web + tip doctrine)
- [x] Kill list ≥ shortlist
- [x] Deep cards
- [x] Weights stated
- [x] 90-day queue ≤5
- [x] Ownership tags N/D/S
- [x] Phase A non-regression restated
- [x] No auto-implement

---

## 10 · What this does **not** claim

- Did not install packages or open adopt code PRs.
- Did not replace Denon’s open PR work.
- Did not assign Shehzad a new stack without his S-D0.
- Did not “finish” pay/bank — only named leverage paths.

---

_Board-Delta: Phase B internet leverage report — ranked external candidates + 90-day queue_
