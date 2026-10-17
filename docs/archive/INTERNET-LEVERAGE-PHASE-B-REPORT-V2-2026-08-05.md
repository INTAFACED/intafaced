> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Internet leverage — Phase B report v2 (external candidates, all-out)

**Status:** RESEARCH EVIDENCE COMPLETE · **decision surface superseded**  
**Date:** 2026-08-05  
**Decisions live in:** [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md) (whole future project; **no max-5 thrift cap**)  
**Supersedes:** [`INTERNET-LEVERAGE-PHASE-B-REPORT-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-REPORT-2026-08-05.md) (v1 / #772) for research depth  
**Note:** Fan-out tables / kill lists / deep cards below remain valid evidence. The “90-day max ≤5 tracks” line was **plan thrift, not operator law** — do not treat it as the Phase B product.  
**Tip at research:** `origin/main` re-derived at write (post-#772 tip)  
**Plan law:** [`INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md`](INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md)  
**Phase A:** [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md)  
**Prior terrain (must not re-discover blind):**  
[`ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md`](ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md) ·  
[`SECURITY-WHEN-PLAIN.md`](SECURITY-WHEN-PLAIN.md) · Denon hard board D-S-01…18

**Term:** Internet leverage = already-built systems we adopt / wire / wrap instead of rebuild.

**Non-regression (Phase A):** vendor shell = sole product UI · `ledger-client` = only book · no second full exchange kit · no Java dual-book · no invent mids.

---

## 0 · Operator one-screen (read this first)

|  Rank | Candidate                                               | Gap it fills                                                        | Owner                  | Action                                                      |
| ----: | ------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| **1** | **RE2-family** (`re2js` pure JS · or `node-re2` native) | ReDoS on untrusted strings (P2P methods, admin parsers)             | **N/D**                | **Adopt now** — wrap once; suite proves linear-time         |
| **2** | **Gitleaks** (MIT) in CI                                | Secret scanning still missing on main (SECURITY-WHEN-PLAIN Track A) | **N**                  | **Adopt now** — highest cheap security leverage             |
| **3** | **Hyperswitch** (Juspay, Apache-2.0, ~43k★, v1.125+)    | Multi-PSP routing / pay residual after #346                         | **N** (+ Class X keys) | **Trial** behind `PayRouterPort`; ledger stays SoT          |
| **4** | **SimpleWebAuthn** (MIT)                                | Passkey / step-up adapter for identity residual                     | **N**                  | **Trial** when identity mountain moves                      |
| **5** | **Moov ACH / Fed / Wire libs** (Apache-2.0)             | US bank file rails for ramps / bank residual                        | **N** + D-S-09         | **Later** adapter when bank.ramps path is real              |
| **6** | **Human P2P dispute desk** (greenfield on tip SPEC)     | Fiat disputes (your ruling: human, not chain jury)                  | **N/D**                | **Build** — no drop-in OSS matched custody escrow + SPEC    |
| **7** | **dYdX v4 / CometBFT / Cosmos SDK** (refs)              | INTACHAIN P1 CLOB-on-appchain pattern                               | **S only**             | **Reference pack** — not Nitro implement                    |
| **8** | **In-tree wallet RPC → then Turnkey / DFNS-class**      | Custody after security review                                       | **D then N**           | **Review first**; vendor only as adapter, never second book |

**You decide (Class X / product):**

1. Which PSPs go live once Hyperswitch-class routing exists.
2. Fund wallet RPC security review before any MPC SaaS.
3. Do **not** buy another full exchange UI kit.
4. Do **not** replace `ledger-client` with Formance / TigerBeetle / Blnk (study only).

**Superseded thrift line (ignore):** old “90-day max ≤5” — full map is [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md).

---

## 0b · Why v1 was lazy (hole poke — methodology failure)

| Failure                          | What v1 did                                                                                                        | What “good” required                                 | Fixed in v2?                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Width collapse**               | ~2–4 candidates/lane, many “LATER” with no search trail                                                            | 8–12 raw per lane → B3 kill                          | **Yes** — full fan-out tables                                                    |
| **Solution-first residue**       | Hyperswitch + RE2 felt pre-chosen; kill list thin                                                                  | Gap-first from Phase A G-\* + D-S-01…18 + tracker    | **Yes** — B0 re-derived                                                          |
| **Ignored prior research**       | Did not cite ORDER-ROUTE landscape (exchange-core already studied) or SECURITY-WHEN-PLAIN (gitleaks already named) | Phase B must **import** prior terrain, not re-invent | **Yes** — gitleaks rises to rank 2                                               |
| **last30days skipped / misused** | No community engine; web-only thin                                                                                 | Skill for shortlist community pulse                  | **Attempted** — engine ran; X/Reddit returned 0 this host; degradation disclosed |
| **Fake Top-5**                   | Kleros ranked #3 while killed for Fiat                                                                             | Rank only actionable adopts                          | **Yes** — Kleros demoted to kill/ref                                             |
| **D-S surface thin**             | Hand-wave “engine law”                                                                                             | Each D-S row: external leverage vs greenfield/spec   | **Yes** — §1.1                                                                   |
| **Tracker mountains missing**    | pay.\* bank.\* trade.\* not expanded                                                                               | Ready rows → lane tags                               | **Yes** — §1.2                                                                   |
| **No GitHub hard facts**         | Stars anecdotally                                                                                                  | Live license / push / release via API                | **Yes** — §8 metadata                                                            |
| **No second-pass hole hunt**     | Checkbox “complete”                                                                                                | Named hunt questions + answers                       | **Yes** — §11                                                                    |
| **No methodology audit**         | Absent                                                                                                             | Why lazy + how to not repeat                         | **Yes** — §12                                                                    |

**Root cause (one line):** treated Phase B as “write a shortlist from memory + a few searches,” not as “wide multi-source collection → hard filters → expensive deep cards → operator queue.”

---

## 1 · B0 — Gap backlog (research anchors)

### 1.0 Phase A gaps (updated)

| GapID      | Need                                | Phase A / tip status                     | Owner       | Lanes              |
| ---------- | ----------------------------------- | ---------------------------------------- | ----------- | ------------------ |
| G-P0-1     | Live depth client                   | **Done** #748 + fleet (verify tip)       | —           | closed             |
| G-P0-2     | Decimal desk bignumber              | Residual wire                            | N           | L-UI (in-repo)     |
| G-P0-3     | Pay residual after #346 handoff     | Handoff asserted; residual free for N    | N           | L-PAY              |
| G-P0-4     | Denon money PR land                 | His pile                                 | D           | _(no external)_    |
| G-P0-5     | Engine product law D-S-01…05        | Spec factory pending                     | D           | L-MATCH libs only  |
| G-P1-1     | OTC/admin/CMS kit path              | Kit under-used                           | N after law | L-UI kill dual-kit |
| G-P1-2     | V-ADMIN primary ops                 | Prefer kit                               | N/D         | L-UI               |
| G-P1-4     | Wallet RPC live                     | Review-first                             | D           | L-CUSTODY          |
| G-P2-1     | apps/web delete                     | D-P2-01                                  | D           | L-KILL dual-start  |
| P2P-D      | Human disputes + ReDoS + GDPR erase | Rulings sent                             | N/D         | L-P2P, L-SEC       |
| FUT-BANK   | earn/cards/ramps                    | Reclaimed                                | N + D-S-09  | L-BANK, L-PAY      |
| FUT-ID     | KYC adapters                        | Residual                                 | N + Class X | L-ID               |
| FUT-MSG    | Notify providers                    | Residual                                 | N           | L-MSG              |
| FUT-MOBILE | Mobile                              | Stubs only                               | N later     | L-MOBILE           |
| FUT-CHAIN  | L1 / INTACHAIN                      | Shehzad board                            | S           | L-CHAIN-REF        |
| G-SEC-A    | Secret scanning on main             | **Named missing** in SECURITY-WHEN-PLAIN | N           | L-SEC              |
| G-OBS      | Ops scale                           | OTEL present                             | N/D         | L-OBS              |
| G-DATA     | Indexer/search/analytics            | Residual                                 | N           | L-DATA             |

### 1.1 Denon D-S-01…18 → external leverage?

| D-S                        | Law topic                                                 | External leverage?                                              | Note |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| 01 Futures risk            | **No** (product law)                                      | Greenfield after law; mark/index = refuse rules not vendor mids |
| 02 OTC desk                | **UI kit + ledger only**                                  | No RFQ OSS desk matched SPEC                                    |
| 03 Copy                    | **No**                                                    | Engine after law                                                |
| 04 Algo                    | NautilusTrader **study only** (LGPL-3.0; not drop-in CEX) | D seal; do not replace svc-trade                                |
| 05 Multi-asset matrix      | **No**                                                    | Enum law, not a lib                                             |
| 06 Matching dual-target    | **Spec reuse** + dYdX v4 pattern for S                    | Fiat keeps svc-matching; no exchange-core port                  |
| 07 Oracle/mark             | **No invent feeds**                                       | Refuse rules; kill “oracle mid as truth”                        |
| 08 P2P + dispute           | Human desk + RE2                                          | Kill Kleros for Fiat                                            |
| 09 Bank money              | Moov ACH libs / card issuer **adapters**                  | Class X issuers                                                 |
| 10 Pay beyond crypto       | Hyperswitch-class orchestration                           | Adapter only                                                    |
| 11 Identity graph          | SimpleWebAuthn + KYC adapters                             | Not full KYC platform self-host                                 |
| 12 Bridge accounting       | S + ledger                                                | No Formance swap                                                |
| 13 Event bus               | In-repo NATS/JetStream                                    | Keep                                                            |
| 14 Token economics         | **No** invent numbers                                     | Spec only                                                       |
| 15 Platform IA             | Kit pages                                                 | Kill second SPA                                                 |
| 16 Class M hold language   | Process                                                   | No OSS                                                          |
| 17 Java dual-book residual | Scans + policy                                            | No OSS                                                          |
| 18 Predict/quant/connect   | **No** until law                                          | §27–§32                                                         |

### 1.2 Tracker ready/wip residual (product free ≠ leverage free)

Representative rows that still need craft (external only if gap-true):

- **pay.\*** gateway/psp/routing/settlement/fraud/subscriptions — L-PAY
- **bank.\*** earn/cards/ramps/sovereign-card — L-BANK
- **trade.\*** futures/otc/copy/algo/options/forex — D-S first
- **p2p.merchants** — L-P2P
- **web.terminal / ws.gateway** wip — mostly in-repo wire
- **protocol.\* / chain.\*** shehzad002 — L-CHAIN-REF only for Nitro

---

## 2 · B1 — Lane map (owners)

| Lane        | In                                                           | Out                                      | Owner       |
| ----------- | ------------------------------------------------------------ | ---------------------------------------- | ----------- |
| L-UI        | Complements shell (a11y, validation, charts already decided) | Full exchange SPA                        | N           |
| L-PAY       | Orchestration, connectors, ACH helpers                       | Second ledger / balance SoT              | N           |
| L-BANK      | File rails, issuer adapters                                  | Guaranteed APY products                  | N + D law   |
| L-P2P       | Dispute desk patterns, safe parsers                          | Auto-adjudicate Fiat                     | N/D         |
| L-ID        | KYC/WebAuthn **adapters**                                    | Sanctions list **content**               | N + Class X |
| L-MSG       | Email/SMS/push SDKs                                          | Second notify platform                   | N           |
| L-DATA      | Search/indexer/warehouse                                     | Invent market data                       | N           |
| L-OBS       | Metrics beyond stock OTEL                                    | Replace stack casually                   | N/D         |
| L-SEC       | ReDoS, secret scan, SAST                                     | Attack prod                              | N/D         |
| L-CUSTODY   | MPC/TEE APIs after review                                    | Dual-book wallets                        | D→N         |
| L-MATCH     | Perf **study**; dual-target **spec**                         | Price invent; Java HFT port as Fiat core | D/S         |
| L-CHAIN-REF | Cosmos/CLOB refs                                             | Nitro builds L1                          | S           |
| L-MOBILE    | RN/Flutter later                                             | Now                                      | Later       |
| L-KILL      | Explicit rejects                                             | —                                        | —           |

---

## 3 · B2/B3 — Fan-out → keep/kill (all-out width)

**Sources used (multi):** official sites, GitHub API (live stars/license/push), industry compare posts, prior in-repo landscape docs, X keyword sample, last30days engine attempt (degraded — see §12).

### L-PAY

| #   | Candidate                                                  | License / maturity                           | Keep?               | Gap                 | Reason                                                                                          |
| --- | ---------------------------------------------------------- | -------------------------------------------- | ------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Hyperswitch**                                            | Apache-2.0 · ~43k★ · pushed 2026-08 · v1.125 | **KEEP**            | G-P0-3, pay.routing | Best open multi-PSP orchestrator; Rust self-host; PCI story; Recurly partnership (2026-07 news) |
| 2   | Hyperswitch Cloud (hosted)                                 | SaaS                                         | **LATER**           | same                | Ops shortcut; Class X vendor                                                                    |
| 3   | Stripe / Adyen / etc. direct SDKs                          | proprietary                                  | **ADAPT**           | pay.psp             | Connector pattern already doctrine — not platform replacement                                   |
| 4   | Moov **platform** (hosted)                                 | proprietary + OSS libs                       | **LATER**           | bank.ramps          | Network-connected processor — US-centric; Class X                                               |
| 5   | **Moov ACH/Wire/Fed libs**                                 | Apache-2.0 · active                          | **KEEP (bank-ish)** | FUT-BANK            | File/spec libraries — not a second book                                                         |
| 6   | Formance payments adjacency                                | MIT ledger core                              | **KILL as book**    | —                   | Programmable ledger = dual-book temptation                                                      |
| 7   | “Open source gateway that stores balances” (generic class) | various                                      | **KILL**            | —                   | Second book                                                                                     |
| 8   | PortOne (commercial / partial OSS)                         | mixed                                        | **LATER**           | pay                 | Evaluate only if Hyperswitch fails spike                                                        |
| 9   | Solidus / Magento pay plugins as product                   | various                                      | **KILL**            | —                   | Wrong stack; pay.plugins is residual craft on our API                                           |
| 10  | Unlimit / Alchemy on-ramp aggregators                      | SaaS                                         | **LATER adapter**   | bank.ramps          | Class X + brand-scan discipline                                                                 |
| 11  | OpenPay-style wrappers of Hyperswitch                      | Apache-ish                                   | **LATER**           | —                   | Prefer first-party Hyperswitch adapter                                                          |
| 12  | Build only one Stripe account forever                      | —                                            | **KILL strategy**   | —                   | Routing residual is real product                                                                |

### L-SEC

| #   | Candidate                                | Keep?        | Reason                                         |
| --- | ---------------------------------------- | ------------ | ---------------------------------------------- |
| 1   | **Google RE2** (C++)                     | REF          | Source of truth for linear-time regex          |
| 2   | **re2js** (MIT, pure JS, active 2026-07) | **KEEP**     | No native addon; good for Node monorepo deploy |
| 3   | **node-re2** (BSD, native)               | **KEEP alt** | Faster for some paths; native build cost       |
| 4   | “Just raise length caps”                 | **KILL**     | Denon ReDoS measurement already disproves      |
| 5   | **Gitleaks** (MIT, ~28k★)                | **KEEP**     | SECURITY-WHEN-PLAIN: still missing on main     |
| 6   | TruffleHog                               | LATER        | Complementary; start with one CI tool          |
| 7   | Semgrep money rules                      | KEEP pattern | Already Tier B in order-route landscape        |
| 8   | Random “AI red team SaaS pack”           | **KILL now** | Strix-class = explicit go only                 |

### L-P2P

| #   | Candidate                                  | Keep?                                      | Reason                                                      |
| --- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------- |
| 1   | **Kleros**                                 | **KILL for Fiat** / REF for protocol later | Crowd jurors ≠ your human moderator + custody escrow ruling |
| 2   | TON/Telegram escrow bots                   | **KILL**                                   | Wrong platform/trust                                        |
| 3   | Generic “dispute marketplace SaaS”         | **KILL**                                   | Custody model clash                                         |
| 4   | In-house queue on tip SPEC-OTC             | **KEEP greenfield**                        | Best fit                                                    |
| 5   | Zendesk/Intercom as ticket skin            | **LATER UX**                               | Not adjudication law                                        |
| 6   | Evidence blob storage patterns (S3+signed) | **ADAPT**                                  | Ops, not product law                                        |

### L-CUSTODY

| #   | Candidate                      | Keep?                         | Reason                                    |
| --- | ------------------------------ | ----------------------------- | ----------------------------------------- |
| 1   | In-tree **wallet RPC**         | **REVIEW first**              | Phase A months-saved claim                |
| 2   | **DFNS** (MPC API)             | **LATER**                     | Institutional; Class X; adapter only      |
| 3   | **Turnkey** (TEE/API)          | **LATER**                     | Competitive DFNS alternative 2026         |
| 4   | Fireblocks-class               | **LATER enterprise**          | Cost/ops                                  |
| 5   | Privy / Magic consumer wallets | **KILL for platform custody** | Wrong threat model for exchange custody   |
| 6   | Random hot-wallet npm          | **KILL**                      | Supply chain                              |
| 7   | Fystack/mpcium OSS MPC libs    | **STUDY**                     | Crypto primitives only — not ops platform |

### L-MATCH

| #   | Candidate                                           | Keep?                                 | Reason                                             |
| --- | --------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| 1   | **svc-matching (in-repo)**                          | **KEEP**                              | Fiat plane SoT                                     |
| 2   | exchange-core (Java, ~2.6k★, last push **2023-10**) | **STUDY only / already in landscape** | Unmaintained; do **not** replace TS doctrine split |
| 3   | liquibook / CppTrader                               | STUDY                                 | C++ refs                                           |
| 4   | nodejs-order-book                                   | **KILL as engine**                    | Toy vs production risk+ledger split                |
| 5   | NautilusTrader (LGPL-3.0, ~25k★)                    | **STUDY algo only**                   | License + not CEX core; D-S-04 research            |
| 6   | hftbacktest                                         | Optional research                     | Seed/MM — not CEX path (prior Tier B)              |
| 7   | dYdX v4 CLOB module                                 | **REF S**                             | Dual-target law D-S-06                             |
| 8   | “Open oracle mid” as match truth                    | **KILL**                              | Invent ban                                         |

### L-CHAIN-REF (Shehzad only)

| #   | Candidate                    | Keep?                      | Reason                                        |
| --- | ---------------------------- | -------------------------- | --------------------------------------------- |
| 1   | CometBFT                     | REF                        | Doctrine §17 P1                               |
| 2   | Cosmos SDK + EVM module path | REF                        | App-chain                                     |
| 3   | **dYdX v4-chain**            | REF                        | Open CLOB-on-Cosmos precedent (~341★, active) |
| 4   | Hyperliquid papers           | REF only                   | Closed/custom — SLO learn, no binary copy     |
| 5   | Random new L1 kits           | **KILL** unless S proposes | Noise                                         |

### L-ID

| #   | Candidate                                           | Keep?             | Reason                                |
| --- | --------------------------------------------------- | ----------------- | ------------------------------------- |
| 1   | **SimpleWebAuthn**                                  | **KEEP**          | MIT, FIDO-friendly, TS-first passkeys |
| 2   | Sumsub / Persona / Veriff / Onfido / Jumio / Shufti | **ADAPTER later** | Class X content separate; brand-scan  |
| 3   | Self-host full KYC stack                            | **KILL for now**  | Ops/legal weight                      |
| 4   | “Privacy KYC” niche SaaS                            | LATER             | Not next 90d                          |

### L-MSG

| #   | Candidate                      | Keep?     | Reason                  |
| --- | ------------------------------ | --------- | ----------------------- |
| 1   | SES / Twilio / FCM / APNs SDKs | **ADAPT** | Behind svc-notify ports |
| 2   | Second notification platform   | **KILL**  | We have svc-notify      |
| 3   | Full chat SaaS as product      | **KILL**  | Kit chat shape only     |

### L-UI

| #   | Candidate                                            | Keep?            | Reason                                                   |
| --- | ---------------------------------------------------- | ---------------- | -------------------------------------------------------- |
| 1   | Another full exchange front end                      | **KILL**         | Phase A non-regression                                   |
| 2   | lightweight-charts                                   | **KEEP in-repo** | Already decided                                          |
| 3   | TradingView Charting Library                         | **HOLD**         | Licence grant; purged path law                           |
| 4   | Zod / Valibot / ArkType for edge response validation | **TRIAL**        | G-P0-2 related honesty — pick one; Zod default ecosystem |
| 5   | Headless a11y libs                                   | TRIAL if claim   | Frontend residual                                        |

### L-OBS / L-DATA

| #   | Candidate                          | Keep?         | Reason                                               |
| --- | ---------------------------------- | ------------- | ---------------------------------------------------- |
| 1   | Existing OTEL/Prom/Grafana compose | **KEEP**      | Don’t replace casually                               |
| 2   | SigNoz (~32k★)                     | **LATER**     | Unified OTel UI — ops burden if self-host ClickHouse |
| 3   | Sentry SaaS                        | LATER         | Errors; cost                                         |
| 4   | Meilisearch / Typesense            | **LATER**     | Only if ops.admin search mountain                    |
| 5   | ClickHouse warehouse               | **LATER**     | Analytics residual                                   |
| 6   | OpenBao (Vault fork, MPL-2.0)      | **LATER ops** | Secrets distribution at deploy — not product         |

### L-BANK (extra)

| #   | Candidate                             | Keep?         | Reason                    |
| --- | ------------------------------------- | ------------- | ------------------------- |
| 1   | Moov ACH/Wire/Fed                     | **KEEP libs** | US rails file correctness |
| 2   | Card issuer sandbox adapters          | **ADAPT**     | Class X issuer pick       |
| 3   | Guaranteed APY yield engines from OSS | **KILL**      | Product law + invent risk |

### L-MOBILE

| #   | Candidate                      | Keep?    | Reason                      |
| --- | ------------------------------ | -------- | --------------------------- |
| 1   | Expo / RN                      | LATER    | No kit source; not 90d      |
| 2   | Flutter                        | LATER    | same                        |
| 3   | Full exchange mobile templates | **KILL** | Second product surface risk |

### L-KILL (global — proof of filtering)

- Second ledger / dual-book “leverage” (Formance, TigerBeetle as SoT, Blnk as SoT, Java MemberWallet)
- Full UI kit replacement while vendor shell exists
- Auto-dispute AI / Kleros as Fiat adjudicator
- Unreviewed custody to mainnet
- CCXT on money path (float + doctrine)
- Oracle mid feeds as matching truth
- exchange-core as Fiat matching replacement
- Mobile app as near-term priority
- Sanctions list **content** as agent-closed Class X

---

## 4 · B4 — Deep cards (shortlist)

### H1 · RE2-family (re2js primary / node-re2 alternate)

| Field            | Assessment                                                                  |
| ---------------- | --------------------------------------------------------------------------- |
| Gap              | P2P-D ReDoS; any untrusted regex                                            |
| Integration cost | **1/5**                                                                     |
| Ops              | None (library)                                                              |
| Security         | Linear-time guarantee is the point                                          |
| Doctrine         | Pure safety                                                                 |
| Owner            | N/D                                                                         |
| Months saved     | High vs incident; small code                                                |
| Residual         | Pattern inventory + tests                                                   |
| Pick             | Prefer **re2js** for pure-JS deploy simplicity; native if hot path needs it |

### H2 · Gitleaks CI

| Field            | Assessment                                            |
| ---------------- | ----------------------------------------------------- |
| Gap              | G-SEC-A — SECURITY-WHEN-PLAIN “still missing on main” |
| Integration cost | **1/5** (GitHub Action / pre-commit)                  |
| Ops              | Low; noise tuning                                     |
| Doctrine         | Supply-chain hygiene                                  |
| Owner            | N                                                     |
| Months saved     | Catastrophic-leak avoidance                           |
| Residual         | False positives; rotation process Class X             |

### H3 · Hyperswitch

| Field                  | Assessment                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Gap                    | G-P0-3 / pay.routing / multi-PSP                                                                    |
| Integration cost       | **3/5** (Rust stack + compose + `PayRouterPort`)                                                    |
| Ops                    | Self-host non-trivial; Cloud option                                                                 |
| Maturity               | ~43k★, Apache-2.0, release train active (v1.125 Jul 2026)                                           |
| Doctrine               | OK **only** if adapters + ledger recipes; never balance SoT                                         |
| Owner                  | N implement; D if routing product law                                                               |
| Community (30d sample) | X: self-host/open-orchestration framing; Recurly partnership news; last30days social thin this host |
| Residual               | PCI scope, connector config, fail-closed to ledger                                                  |
| Kill if                | Team starts posting balances inside Hyperswitch as truth                                            |

### H4 · SimpleWebAuthn

| Field            | Assessment                         |
| ---------------- | ---------------------------------- |
| Gap              | FUT-ID step-up / passkeys          |
| Integration cost | **2/5**                            |
| License          | MIT                                |
| Owner            | N                                  |
| Residual         | Credential storage design; not KYC |

### H5 · Moov ACH family

| Field            | Assessment                                        |
| ---------------- | ------------------------------------------------- |
| Gap              | bank.ramps / US ACH file correctness              |
| Integration cost | **2/5** for libs; **4/5** if Moov network account |
| License          | Apache-2.0                                        |
| Owner            | N + D-S-09                                        |
| Residual         | Geography (US-first); Class X banking             |

### H6 · Human dispute desk (greenfield)

| Field       | Assessment                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| Gap         | P2P-D                                                                                |
| Why not OSS | No self-hosted moderator desk matched SPEC + custody escrow without wrong incentives |
| Owner       | N/D                                                                                  |
| Residual    | Staffing/ops; GDPR erase                                                             |

### H7 · Chain ref pack (Shehzad)

| Field     | Assessment                                       |
| --------- | ------------------------------------------------ |
| Gap       | FUT-CHAIN / D-S-06                               |
| Artifacts | CometBFT, Cosmos SDK, dydxprotocol/v4-chain CLOB |
| Owner     | **S only**                                       |
| Residual  | Perf SLOs ≠ copy Hyperliquid binary              |

### H8 · Custody vendors (later)

| Field   | Assessment                                         |
| ------- | -------------------------------------------------- |
| Gap     | G-P1-4                                             |
| Order   | Wallet RPC review → then DFNS **or** Turnkey spike |
| Cost    | **4/5** + Class X                                  |
| Kill if | Bypasses ledger accounting                         |

### Explicit non-cards (tempting, already filtered)

| Temptation                       | Verdict                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| Formance / TigerBeetle as ledger | **KILL replace** — study recipes only (prior landscape agrees) |
| exchange-core replace matching   | **KILL** — unmaintained + doctrine split                       |
| Nautilus as CEX core             | **KILL** — LGPL + wrong product shape                          |
| SigNoz day-1                     | **LATER** — OTEL stack exists                                  |

---

## 5 · B5 — Rank weights + scores

| Weight | Factor                                      |
| -----: | ------------------------------------------- |
|    30% | Gap severity (blocks money / UX / security) |
|    25% | Doctrine / safety fit                       |
|    20% | Integration cost (invert)                   |
|    15% | Maturity / maintenance                      |
|    10% | Multi-mountain unlock                       |

| Candidate          | Severity | Doctrine | Cost↓ | Maturity | Multi | Composite (approx) |
| ------------------ | -------- | -------- | ----- | -------- | ----- | ------------------ |
| RE2                | 9        | 10       | 10    | 9        | 7     | **~9.1**           |
| Gitleaks           | 8        | 10       | 10    | 10       | 6     | **~8.8**           |
| Hyperswitch        | 9        | 8        | 5     | 9        | 8     | **~7.9**           |
| SimpleWebAuthn     | 6        | 9        | 8     | 8        | 5     | **~7.2**           |
| Moov ACH libs      | 5        | 9        | 7     | 8        | 6     | **~6.9**           |
| Human dispute desk | 8        | 10       | 4     | n/a      | 5     | **~7.0** (build)   |
| Chain ref pack     | 7        | 10       | n/a   | 8        | 4     | S-only             |
| MPC vendors        | 7        | 6        | 3     | 8        | 5     | later              |

---

## 6 · B6 — 90-day adopt queue (max 5 tracks)

| #   | Track                          | Days 0–30                          | 30–60                  | 60–90                 | Done bar                                                      |
| --- | ------------------------------ | ---------------------------------- | ---------------------- | --------------------- | ------------------------------------------------------------- |
| 1   | **RE2 on hot parsers**         | Wrap + P2P method path             | Rollout hot paths      | ReDoS suite green     | Catastrophic backtrack test fails on stock RegExp, passes RE2 |
| 2   | **Gitleaks CI**                | Action on PRs + baseline allowlist | Pre-commit optional    | Rotate process note   | CI red on synthetic secret fixture                            |
| 3   | **Hyperswitch spike**          | Compose trial, no ledger bypass    | Design `PayRouterPort` | Thin sandbox card/PSP | Intent → connector mock → ledger recipe only                  |
| 4   | **P2P human dispute path**     | list/evidence/admin per ruling     | Shell wire             | Timer ≠ adjudicator   | Human resolve path only                                       |
| 5   | **Wallet RPC security review** | Denon threat model                 | Fix or quarantine      | No live mainnet       | Written review artifact                                       |

**Not in 90 days:** mobile, SigNoz swap, matching engine replace, Kleros Fiat, Formance ledger, full KYC self-host, MPC go-live.

---

## 7 · Ownership tags (N / D / S)

| Candidate                  | N                    | D                                  | S                          |
| -------------------------- | -------------------- | ---------------------------------- | -------------------------- |
| RE2 / Gitleaks             | implement            | seal if money path                 | —                          |
| Hyperswitch                | implement adapter    | product law if routing rules novel | —                          |
| SimpleWebAuthn / Moov libs | implement            | D-S-09/11                          | —                          |
| Dispute desk               | implement            | D-S-08 seal                        | protocol escrow later only |
| Chain refs                 | babysit only         | dual-target law                    | **owns**                   |
| MPC vendors                | adapter after review | **security go**                    | SA contracts if chain      |

---

## 8 · Live metadata snapshot (2026-08-05, `gh api`)

| Repo                           | ★     | License      | Last push              |
| ------------------------------ | ----- | ------------ | ---------------------- |
| juspay/hyperswitch             | 43388 | Apache-2.0   | 2026-08-04             |
| gitleaks/gitleaks              | 28481 | MIT          | 2026-07-29             |
| nautechsystems/nautilus_trader | 25275 | LGPL-3.0     | 2026-08-04             |
| SigNoz/signoz                  | 31775 | NOASSERTION  | 2026-08-04             |
| google/re2                     | 9771  | BSD-3-Clause | 2026-01-22             |
| openbao/openbao                | 6925  | MPL-2.0      | 2026-08-04             |
| exchange-core/exchange-core    | 2593  | Apache-2.0   | **2023-10-08** (stale) |
| MasterKale/SimpleWebAuthn      | 2297  | MIT          | 2026-08-01             |
| formancehq/ledger              | 1328  | MIT          | 2026-08-04             |
| moov-io/ach                    | 557   | Apache-2.0   | 2026-08-04             |
| uhop/node-re2                  | 556   | BSD-3-Clause | 2026-07-31             |
| dydxprotocol/v4-chain          | 341   | NOASSERTION  | 2026-07-29             |
| le0pard/re2js                  | 204   | MIT          | 2026-07-29             |

Hyperswitch latest release sampled: **v1.125.0** (2026-07-10).

---

## 9 · Sources (research trail — not a dump)

- Hyperswitch: hyperswitch.io about/pricing; GitHub juspay/hyperswitch; 2025–2026 US/EU expansion; Recurly partnership posts (Jul 2026 X)
- Payments landscape: multi-orchestrator industry roundups 2026
- RE2 / re2js / node-re2: Google RE2 README; re2js v2 ReDoS claims; npm bindings
- Gitleaks: GitHub + SECURITY-WHEN-PLAIN prior naming
- Matching: prior ORDER-ROUTE landscape; GitHub topics order-book/matching-engine; exchange-core staleness
- Custody: DFNS vs Turnkey 2026 compare posts
- Chain: dydxprotocol/v4-chain; CometBFT; Cosmos SDK
- Disputes: Kleros docs (ref only); tip SPEC-OTC + operator human ruling
- Secrets ops: OpenBao vs Vault BSL 2026
- KYC: Sumsub alternatives roundups 2026 (adapters later)
- Validation: Zod/Valibot/ArkType 2026 benchmarks
- last30days v3.11.1 engine: attempted on Hyperswitch (degraded social — see §12)

---

## 10 · Phase A non-regression checklist

- [x] No second product SPA recommended
- [x] No second ledger SoT recommended
- [x] No invent mids/oracle truth
- [x] Partner names stay in adapters
- [x] Shehzad L1 not stolen by Nitro implement
- [x] Denon open PR dual-edit not proposed
- [x] Class X not agent-closed

---

## 11 · Hole hunt — second pass (named questions)

| Hunt question                               | Result                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Did we re-discover ORDER-ROUTE tools?       | **No** — imported; exchange-core already STUDY                                 |
| Did we miss secret scanning?                | **v1 yes → v2 fixed** (Gitleaks rank 2)                                        |
| Any lane empty without “searched — no fit”? | No — each lane has keep/kill                                                   |
| Tracker pay/bank/trade covered?             | Yes via FUT-\* + D-S map                                                       |
| Mobile over-researched?                     | Explicitly deferred                                                            |
| Formance/TigerBeetle temptation?            | Named and **killed as SoT**                                                    |
| last30days fully leveraged?                 | **Partial** — engine ran; social thin; web/GitHub/X filled                     |
| Dual-build Denon/Shehzad risk?              | Tagged owners; no implement                                                    |
| Brand-scan risk in this doc?                | Used product names for research only; user-facing copy still adapters-only law |
| Anything v1 ranked wrong?                   | Kleros demoted; Gitleaks promoted                                              |

**None remaining that change the Top queue** after this hunt.

---

## 12 · Methodology + internet-leverage final audit (peace loop)

### 12.1 What “all-out Phase B” means (and does not)

| Means                                | Does not mean                         |
| ------------------------------------ | ------------------------------------- |
| Gap-first multi-lane fan-out         | Infinite research forever             |
| Hard kill list larger than shortlist | Shopping for fun stars                |
| Deep cards only on survivors         | 200-link dump                         |
| Import prior in-repo research        | Re-auditing vendor shell as “new OSS” |
| Disclose tool degradation            | Pretend community signal when empty   |
| Operator queue ≤5                    | Auto-implement without pick           |

### 12.2 last30days honesty

- Skill loaded (v3.11.1), plan written, engine invoked with `--github-repo=juspay/hyperswitch` and fintech/selfhosted subreddits.
- Result: **~22s**, YouTube sparse, **Reddit 0 / X 0** this host, save to `Documents/Last30Days` hit **permission error**.
- **Not claimed as rich community consensus.** X keyword tool + web + GitHub used as compensating controls.
- Future: re-run last30days when X cookies/API + save dir writable — community pulse still valuable for Hyperswitch ops pain.

### 12.3 Internet leverage quality bar (meta)

Internet leverage is **good** only when:

1. It fills a **named gap** still open after Phase A.
2. License and doctrine survive B3.
3. Integration cost is honest.
4. Owner plane is correct (N/D/S).
5. Residual risk is written.
6. Prior in-repo work is not ignored.

v1 failed 1 (thin gaps), 5 (shallow residual), and 6 (missed gitleaks/ORDER-ROUTE). v2 passes those gates for the Top queue.

### 12.4 Loop-back self-check

| Check                                         | Pass? |
| --------------------------------------------- | ----- |
| Every Phase A open gap has a lane or “closed” | Yes   |
| Every D-S has external vs greenfield note     | Yes   |
| Kill list ≥ shortlist                         | Yes   |
| No implement in this pass                     | Yes   |
| Class X human                                 | Yes   |
| Supersedes thin v1 explicitly                 | Yes   |
| Actionable 90-day ≤5                          | Yes   |

### 12.5 Residual uncertainty (honest)

- Hyperswitch ops pain at our scale: **not** fully community-validated this run (social sources empty).
- Card issuer / ramp **providers** still Class X pick — research names categories, not signed contracts.
- Matching dual-target law still **Denon+Shehzad** — external refs only.

These do **not** block the RE2 / Gitleaks / dispute-desk tracks.

---

## 13 · Completeness (plan §7)

- [x] B0 gap backlog from tip + boards + tracker
- [x] B1 lanes all addressed
- [x] B2 multi-source fan-out
- [x] B3 keep/kill every raw
- [x] B4 deep cards
- [x] B5 weights stated
- [x] B6 90-day queue ≤5
- [x] Ownership N/D/S
- [x] Phase A non-regression
- [x] Hole hunt
- [x] Methodology audit
- [x] No auto-implement

---

## 14 · What this does **not** claim

- Did not install packages or open adopt code PRs.
- Did not replace Denon’s open PR work.
- Did not assign Shehzad a new stack without S-D0.
- Did not “finish” pay/bank — only named leverage paths.
- Did not claim last30days produced a full multi-platform corpus this host.

---

_Board-Delta: Phase B v2 internet leverage — gap-first all-out shortlist + methodology peace audit (supersedes #772 thin report)_
