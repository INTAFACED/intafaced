> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Internet leverage — partner brief (for Denon + his agent)

**Audience:** Denon (`@Phantom-X-007`) and agents working for him.  
**From:** Nitro operator direction (agents executed; he does not run git).  
**Date:** 2026-08-05 · tip re-derive when acting  
**Purpose:** One place with enough context to reason **without inventing product law, dual-book, dual UI kit, or inventing prices.**  
**Not a request for Nitro homework.** Product-law specs (D-S-\*) stay Denon’s factory.

---

## 0 · What Nitro wanted (intent)

| #      | Intent                                                                                     | What we did                                                                                       |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **A1** | Check that **already-owned** leverage is what agents should use for residual craft **now** | **Phase A** audit of in-repo assets (kit + services + ledger)                                     |
| **A2** | Stop agents **missing** that leverage and vibe-coding rebuilds                             | **Standing law** + agent auto-load + PR checklist + CI scan so cold agents cannot drop the duty   |
| **A3** | Stop **drift** (agents forgetting shell/ledger/svc ownership)                              | Law home + agent entry files + protocol chain + gates that already ban second book / invent money |
| **B1** | **Full-scope** future residual: for every open product row, what path to use               | **Full-horizon map** — 89/89 open tracker IDs as **named rows** (not thrift “top 5 only”)         |
| **B2** | Smart **new external** leverage where Phase A leaves real holes                            | **Phase B research** (shortlist + kills + doctrine filters)                                       |
| **P**  | Pack for **partner agent** with full context, no compromise                                | **This brief** + links below                                                                      |

---

## 1 · Plain English outcome

**We are not starting from zero.**  
Product UI = vendored exchange shell. Money truth = our ledger only. Domain backends = existing TypeScript services. Agents must **wire and extend those**, not ship a second SPA, second balance book, or fake live prices.

**Where something is still open**, the full-horizon map says whether to:

- **IN** — use what we already have
- **EXT** — trial/adopt outside OSS/SaaS **as adapter**
- **GF** — greenfield (no good drop-in)
- **LAW** — Denon product law first (D-S-\*)
- **S** — Shehzad chain plane only
- **X** — Nitro human Class X (keys, issuers, sanctions **content**, mainnet custody go-live)
- **KILL** — never (dual-kit, dual-book, invent mids, etc.)

**Nitro does not re-pick leverage per chat.** Agents proceed under law. Class X and D-S product law remain human/Denon as already owned.

---

## 2 · Non-negotiables (do not “helpfully” relax)

| Rule                                                                            | Source                     |
| ------------------------------------------------------------------------------- | -------------------------- |
| Sole product UI = vendor shell (`vendor/upstream-exchange/05_Web_Front`, :8090) | ADR + Phase A              |
| Only money book = `packages/ledger-client` / `svc-ledger`                       | Doctrine §0.6 + Phase A    |
| No invent mids/depth/prices                                                     | Honesty doctrine           |
| Partner/PSP names only in adapters                                              | Brand law                  |
| Shehzad owns protocol / INTACHAIN implement                                     | Three-way ownership        |
| Denon owns product-law factory D-S-01…18 and his open PR paths                  | Hard board + dual-edit ban |
| Class X never agent-closed                                                      | Ownership law              |

---

## 3 · Phase A — what we already have (use first)

**Law home (enforcement):** [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md)  
**Full asset map:** [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md)

### 3.1 Decision: Phase A is **sufficient for NOW residual craft**

Agents should not wait for a new kit or new ledger. Default:

| Need                                                                                   | Use this                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Trader / product screens                                                               | `vendor/upstream-exchange/05_Web_Front` (+ intafaced overlays)              |
| Ops UI patterns                                                                        | Prefer `04_Web_Admin` shape; `apps/admin` exists — not a second product SPA |
| Money moves                                                                            | Ledger recipes only                                                         |
| Pay / bank / trade / match / p2p / identity / ws / notify / agents / academy / support | Matching `services/svc-*` (18 on tip, including `svc-support`)              |
| Custody stack in tree                                                                  | `01_wallet_rpc` — **review before live** (not unaudited mainnet)            |
| Mobile kit                                                                             | Stubs only — no real mobile source leverage yet                             |

### 3.2 How agents are bound (so we don’t drift like before)

| Mechanism                                                       | What it does                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `docs/INTERNET-LEVERAGE-LAW.md`                                 | Standing rule: prefer IN; PR names leverage                          |
| `AGENTS.md` + agent entry files                                 | Cold start loads leverage duty                                       |
| `AGENT_PROTOCOL.md`                                             | Hard bans: second SPA, second book, invent prices, skip leverage     |
| PR template checkbox                                            | Leverage named on every PR                                           |
| `tooling/ci/agent-autoload-scan.mjs` (in `pnpm gates` / verify) | **CI fails** if leverage law is stripped from auto-load chain        |
| Existing money/UI scans                                         | Dual-book, custody, brand, vendor-shell still red on real violations |

**Honest limit:** CI cannot prove an agent _thought_ about leverage on every line of a PR. It **can** keep the duty in every session brief and block silent deletion of that duty. Review + self-audit still matter on Class M.

### 3.3 Tip facts Phase A already absorbed

- `apps/web` product role **deleted**
- Vendor path = `vendor/upstream-exchange`
- Depth **client** shipped (#748); residual = **prove live E2E**, not “no client”
- Open human PRs re-derive with `gh pr list` (do not cite folklore piles)

---

## 4 · Phase B — full future scope + external shortlist

### 4.1 Full residual path map (every open tracker id)

**Canonical:** [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md)

- **89/89** non-done tracker features as **named rows** (script-verified; no `agents.*` wildcards).
- Plus non-tracker rows: security (RE2, Gitleaks), human P2P dispute desk, D-S factory, wallet review, etc.
- Ranking = **start order**, not a thrift ceiling of five forever.

**Re-verify anytime:**

```bash
node -e "
const {FEATURES}=require('./tooling/tracker/features.mjs');
const open=FEATURES.filter(x=>x.status&&x.status!=='done');
const doc=require('fs').readFileSync('docs/INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md','utf8');
const miss=open.filter(x=>!doc.includes('\`'+x.id+'\`'));
console.log('open', open.length, 'missing', miss.length);
"
```

### 4.2 External / research shortlist (smart new leverage)

**Evidence tables:** [`INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md)  
**Execute stamp / gate story:** [`INTERNET-LEVERAGE-PHASE-B-EXECUTE-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-EXECUTE-2026-08-05.md)  
**Plan (hardened):** [`INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md`](INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md)

| Priority    | Candidate                                                                                                                                                                                     | Job                     | Owner                | Notes                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NOW         | **ReDoS-safe matchers** — **split locked** (see law §3.2): operator patterns → in-tree `linear-pattern`; engineer parsers → `@intafaced/safe-regex` (re2js pure JS); **no** native `node-re2` | ReDoS-safe parsers      | N/D                  | Nitro 2026-08-05: re2js is not native RE2 (Denon correction accepted); not a free swap for operator non-ASCII patterns                                                                               |
| NOW         | **Gitleaks**                                                                                                                                                                                  | Secret scanning CI      | N                    | Track A; tip already landed always-on (#786)                                                                                                                                                         |
| **KILL**    | **Hyperswitch**                                                                                                                                                                               | Multi-PSP orchestration | —                    | **Refused** ADR `2026-08-04-pay-rails-and-psp-socket` (D-S-10, #769): orchestrator ≠ acquirer; Doctrine 5 no third-party connectivity lib in money path; `socket.psp-partners` is commercial Class X |
| MID         | **SimpleWebAuthn**                                                                                                                                                                            | Passkeys / step-up      | N                    | After D-S-11 as needed                                                                                                                                                                               |
| MID         | **Moov ACH/Wire/Fed libs**                                                                                                                                                                    | US file rails for ramps | N + D-S-09           | Libs, not second book                                                                                                                                                                                |
| NOW         | **Human P2P dispute desk**                                                                                                                                                                    | Fiat disputes           | N/D                  | **Built / in flight** (not GF-pending): backstop removed, disputes.list, evidence, trigger requires human moderator — Kleros still KILL for Fiat                                                     |
| **NOW (D)** | **Wallet RPC defects** (not “review later”)                                                                                                                                                   | Custody path            | **D** (+ N residual) | **Critical:** EtherscanApi mainnet hardcode; PaymentHandler dual-broadcast; pre-EIP-155 signs; live mainnet USDT pinned — frozen by gate #763; **none fixed** per Denon 2026-08-05                   |
| LATE        | DFNS / Turnkey-class                                                                                                                                                                          | MPC custody API         | D→N + X              | After review; adapter only                                                                                                                                                                           |
| LATE        | Zod (or Valibot)                                                                                                                                                                              | Runtime edge validation | N                    | Honesty residual                                                                                                                                                                                     |
| MID         | fast-check                                                                                                                                                                                    | Money property tests    | N                    | Prior order-route Tier A                                                                                                                                                                             |
| LATE        | Toxiproxy / Semgrep / analytics warehouse                                                                                                                                                     | Ops/chaos               | N/D                  | When pain warrants                                                                                                                                                                                   |
| S only      | CometBFT / Cosmos SDK / dYdX v4 pattern                                                                                                                                                       | INTACHAIN refs          | **S**                | Not Nitro L1                                                                                                                                                                                         |

### 4.3 Explicit kills (do not reopen)

- Second full exchange UI kit
- Second ledger SoT (Formance / TigerBeetle / Blnk / Java MemberWallet as book)
- Invent mids / oracle-as-truth
- Kleros / AI as **Fiat** dispute adjudicator (conflicts human + custody escrow ruling)
- CCXT on money path
- exchange-core as Fiat matching replacement
- Nitro implementing Shehzad L1 core
- Dual-edit open Denon/Shehzad PR files

### 4.4 Suggested agent start order (no Nitro pick list)

1. **IN** residual on free paths (depth E2E prove, decimals, shell honesty, pay residual on `svc-pay` after handoff).
2. **Safe EXT already decided:** ReDoS **split** (law §3.2 — linear-pattern for operator patterns; `@intafaced/safe-regex` for engineer parsers); Gitleaks (landed).
3. **Pay residual:** commercial `socket.psp-partners` / Class X — **not** Hyperswitch (refused D-S-10 ADR #769).
4. **LAW rows:** Denon D-S-\* first; agents implement from specs or refuse-closed thin.
5. **X rows:** Nitro human only.

---

## 5 · What Denon (and his agent) should do with this

| Role                      | Useful action                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Denon direction**       | Write D-S-\* specs that **name** Phase A leverage (kit screen + ledger recipe + our svc) so agents cannot invent engines         |
| **Denon open PRs**        | Land his pile; agents babysit only on his paths                                                                                  |
| **Denon security**        | Wallet RPC review program before custody go-live                                                                                 |
| **His agent**             | Treat this brief + linked maps as law; self-audit money/doctrine before merge; do not dual-build Nitro residual or Shehzad chain |
| **Not needed from Nitro** | Another “please choose Top 5” — already decided under INTERNET-LEVERAGE-LAW                                                      |

---

## 6 · Document index (drill-down)

| Doc                                                                                                            | Role                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md)                                                         | **Enforcement** — binding agent ritual                                                                                                                                                                                     |
| [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md)               | Phase A asset register + gaps                                                                                                                                                                                              |
| [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md) | Every open tracker path                                                                                                                                                                                                    |
| [`INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md)       | External research evidence                                                                                                                                                                                                 |
| [`INTERNET-LEVERAGE-PHASE-B-EXECUTE-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-EXECUTE-2026-08-05.md)           | Gate + execute stamp                                                                                                                                                                                                       |
| [`INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md`](INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md)                 | Methodology (full-horizon, no max-5 thrift)                                                                                                                                                                                |
| [`INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md`](INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md)       | Why gates existed                                                                                                                                                                                                          |
| Ownership                                                                                                      | [`THREE-WAY-DISTRIBUTION-2026-08-04.md`](THREE-WAY-DISTRIBUTION-2026-08-04.md) · [`DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md`](DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md) · Shehzad blockchain board |

---

## 7 · Non-claims (so we don’t oversell)

- Not “platform complete.” Residual craft remains.
- Not every LATE external row re-web-researched on the last stamp — shortlist has depth; full-horizon has complete **path assignment**.
- Not a substitute for Denon D-S product law on futures/OTC/copy/algo/etc.
- Not permission for Class X agent-close.

---

## 8 · One paragraph you can paste to Denon

We finished an internet-leverage program: Phase A maps everything we already own (vendor shell as product UI, ledger as only book, all svc-*). That is **enough for residual craft now** and is **standing agent law** (agent entry files + protocol + PR checkbox + CI auto-load so it cannot vanish). Phase B is full-scope: every open tracker row has a named path (IN/EXT/GF/LAW/S/X/KILL), plus a shortlist of smart externals (ReDoS **two-tool split** — operator patterns keep linear-pattern, engineer parsers use `@intafaced/safe-regex`/re2js; Gitleaks; SimpleWebAuthn; Moov ACH libs; human dispute desk built/in-flight; wallet RPC **critical** not mid; **Hyperswitch refused** per D-S-10 ADR) and hard kills (second kit, second book, invent mids, Kleros for Fiat, Nitro L1). Partner brief + links: `docs/INTERNET-LEVERAGE-PARTNER-BRIEF-2026-08-05.md` on tip. Please have your agent self-audit against doctrine and name leverage in D-S specs (kit + ledger + svc) so implementers cannot invent engines.

---

---

## 9 · Alignment after Denon review (2026-08-05) — no contradiction with law

| Denon point                   | Decision (locked)                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase A core + kill list      | **Agree** — remains law                                                                                                                                                                                                                                                                                                                                                       |
| Enforcement + honest CI limit | **Agree**                                                                                                                                                                                                                                                                                                                                                                     |
| **Hyperswitch MID**           | **Remove / KILL** — already refused D-S-10 ADR `docs/adr/2026-08-04-pay-rails-and-psp-socket.md` (#769). Brief was wrong; ADR wins. Not reopened.                                                                                                                                                                                                                             |
| **RE2 NOW**                   | **Locked split (Nitro 2026-08-05):** accept Denon correction that `@intafaced/safe-regex` is re2js pure JS (not native). **Operator** P2P patterns stay on `linear-pattern.ts` (full JS surface for non-ASCII account IDs). **Engineer** parsers use `@intafaced/safe-regex`. Native `node-re2` still banned. Agents do not silently re2js-swap operator patterns. Law: §3.2. |
| Dual-edit files only          | **Necessary not sufficient** — add **per-branch test database isolation** (shared Postgres + migrate-on-startup contamination)                                                                                                                                                                                                                                                |
| Depth E2E residual            | **Closed / proven** (Denon measured fleet rebuild) — map was behind                                                                                                                                                                                                                                                                                                           |
| Human dispute desk GF         | **Behind** — built / in flight under human-moderator ruling                                                                                                                                                                                                                                                                                                                   |
| Wallet RPC MID review         | **Behind** — **NOW critical defects**, #763 freeze, unfixed mainnet dual-broadcast class bugs                                                                                                                                                                                                                                                                                 |
| D-S leverage naming           | **Agree** — Denon reports D-S board **18 done · 0 partial · 0 blank**; e.g. D-S-01 binds futures to existing `prices.ts` vocabulary                                                                                                                                                                                                                                           |

**Doctrine note Denon corrected:** Hyperswitch objection is **not** primarily §0.6 dual-book (no balance columns). It is **orchestrator ≠ acquirer**, **Doctrine 5 / no third-party connectivity library in money path**, and **non-extractable connectors**.

_Board-Delta: ReDoS split locked — operator linear-pattern; engineer safe-regex/re2js; Denon RE2 correction accepted_
