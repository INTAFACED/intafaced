# Protocol P0 takeover — calibration (before the plan)

**Status:** Frame for the next planning pass. **Not** the implementation plan. **Not** a Sepolia deploy. **Not** INTACHAIN.  
**Date:** 2026-09-18  
**Tip at write:** `origin/main` `ff160a109`  
**Owner this wave:** Nitro / this program. Shehzad wait is **cancelled**.  
**Rail:** Base Sepolia (84532) → Base mainnet later (Class X). Anvil = CI. Not Arc. Not “our chain.”

This file exists so the later plan cannot “forget a section.” Planning that skips a section below is incomplete.

---

## 0 · What you just decided (binding)

| Decision                | Meaning                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Stick with Base         | P0 rails ADR (8 Aug) stands. Arc is a watch item, not home.                                                                             |
| Own L1 stays parked     | 3 Sep ADR stands. No `svc-chain`.                                                                                                       |
| Take over Protocol      | Agents **babysit-only** is overruled for P0. Do not wait on [#4199](https://github.com/Phantom-X-007/intafaced/issues/4199) or Shehzad. |
| House book stays house  | Matching / bank / pay / ledger do not move onto Base.                                                                                   |
| Vue is not this program | Codex owns `05_Web_Front` after addresses exist.                                                                                        |

Phase 0 of the mega (“Shehzad posts three lines”) is **closed by this chat**: Base, not Arc, not INTACHAIN.

---

## 1 · Current state (honest)

**Already on `main` (do not rebuild):** smart accounts, passkey, recovery, session keys, paymaster _contract_, AMM, lending, escrow, router, merchant, launch/fair/NFT/RWA, stealth, crew/legacy vaults, SovereignVenue, audit pipeline (S-J1), CardPull seam (#2473).

**Missing as a product:**

| Hole                      | English                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Public Sepolia addresses  | Deployment registry has example/dev only. `INDEXER_VENUE_ADDRESS` default empty.                                                      |
| Indexer on the real venue | Still DevVenue fixture until a published address. `socket.clob-contracts` is **ready**, not done (`audited:false`, no public deploy). |
| 4337 live                 | Bundler commodity on 84532. No proof **our** account sent a UserOp on Sepolia.                                                        |
| Wallet journeys           | Rooms exist as contracts on anvil. Not a stranger-click on Basescan.                                                                  |
| Protocol execution (S-I4) | Quote-only adapters; `submit()` refuses. Biggest later mountain. Not Phase 1.                                                         |
| Shehzad                   | Last commit **2 Sep**. Open PRs **none**. #4199 unanswered.                                                                           |

**Not missing:** INTACHAIN, Arc, IFC on-chain, live card issuer, DEX external venue set, paid audit. Those stay sockets / Class X / parked.

---

## 2 · The two mountains (do not mash)

| Mountain                | What “done” looks like                                                                                                         | Size                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **A — Sepolia product** | Phases 1–4 including SovereignVenue `place` from a smart account. Testnet. `audited:false`. Not INTACHAIN.                     | Ops + wiring. Contracts already exist.                                                   |
| **Old “B”**             | Mega S-I4 mashed protocol fill with Fiat OMS + Vault. Split: protocol fill ∈ A; Fiat OMS exists; external execute is a socket. | [`PROTOCOL-P0-EXECUTION-SPLIT-2026-09-18.md`](PROTOCOL-P0-EXECUTION-SPLIT-2026-09-18.md) |

This takeover is **A**. Planning that opens with a new `svc-execution` or `svc-chain` has the wrong mountain.

---

## 3 · Phase map (needles — keep these)

From `docs/PROTOCOL-P0-BASE-MEGA-2026-09-06.md`, ownership rewritten:

| Phase | Needle                                                                                                                                                      | Who now                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **0** | Rail + owner named                                                                                                                                          | **Done** (this file + Base/Arc briefing) |
| **1** | Stranger opens Basescan, sees **our** verified contracts on **84532**, labelled testnet / not INTACHAIN / `audited:false`. Registry non-zero.               | Agents                                   |
| **2** | Indexer + quote path read **SovereignVenue** at that address. DevVenue fixture-only.                                                                        | Agents                                   |
| **3** | One UserOperation for **our** account on Sepolia (not a Pimlico Safe demo). Bundler configured. Paymaster refuse-unfunded still true unless you fund float. | Agents                                   |
| **4** | Wallet clicks: account, **SovereignVenue place**, AMM, launch (test token **not** IFC), plus other in-suite rooms or honest skip. Protocol Done ≠ Vue.      | Agents; Vue later Codex                  |
| **5** | External venue execute (Connect). Socket until you name venues. Not a new OMS.                                                                              | Later / Class X names                    |
| **6** | Adversarial leftover on the live suite. Fake `audited:true` still refused.                                                                                  | Later / ongoing                          |
| **7** | Base **mainnet**                                                                                                                                            | **You** — keys, gas, go-live yes         |

Do not stamp a later phase Done because an earlier one has a PR.

---

## 4 · Sections the later plan must have (completeness)

A plan that cannot point at each of these is not ready:

1. **Scope lock** — P0 on Base Sepolia. House book out. INTACHAIN out. Arc out. IFC token out.
2. **Honesty needles** — copy Phase 1–4 needles; no “deployed” without explorer URL + registry row.
3. **Do not rebuild** — named contract list already on `main`. Gaps are deploy/wire/prove, not rewrite AMM.
4. **Money / planes** — Protocol never writes the ledger. Fills (when they exist) final at **chain**. Quote asset = ETH or mock stable, never IFC.
5. **Deploy mechanics** — Foundry, chain 84532, registry JSON, sourceHash, verify on Basescan. Env stays refuse-closed when blank (`PROTOCOL_CHAIN_ID`, `PROTOCOL_RPC_URL`, `INDEXER_VENUE_ADDRESS`).
6. **4337** — vendor pick (Pimlico is proven). No hand-rolled bundler. No block on native AA (vibenet-only).
7. **Indexer** — WS-capable RPC (public `sepolia.base.org` is HTTP-only). One venue address. No second venue contract.
8. **Account path** — passkey / recovery / session already specified; prove on Sepolia or name anvil-only residual honestly.
9. **Journeys** — table of rooms; order; what “wallet click” means without Vue.
10. **Frontend split** — empty shell is not a Shehzad/agent sit. Codex after addresses.
11. **Execution deferred** — S-I4 / Venue Vault / `socket.dex-execution` in a later plan. Keep `submit()` loud-refuse until then.
12. **Class X named** — paid audit, mainnet keys, paymaster **float**, live issuer, DEX _external_ venue names, go-live yes. Sepolia **does not wait** on those.
13. **PR law** — one service per PR (`svc-protocol` deploy residual vs `svc-indexer` vs bundler config). `pnpm wt`. No push to `main`.
14. **Parked list** — copy mega § parked. Dual-deploy still banned.
15. **Finish predicate for A** — Phase 1–4 needles true on Sepolia **and** registry in git **and** labels honest.
16. **Human leftover** — Sepolia deployer key with testnet ETH (not in repo). Public RPC exists. Faucet is enough for Phase 1. Mainnet is not.

---

## 5 · Unspoken needs (used as tests)

| Need                           | How the later plan fails if ignored           |
| ------------------------------ | --------------------------------------------- |
| Don’t wait on a silent partner | Any “Shehzad first” gate                      |
| Don’t spend L1 money           | `svc-chain` / genesis / Arc-as-home           |
| Don’t fake a chain             | “INTACHAIN” or `audited:true` on Sepolia      |
| Don’t mash mountains           | S-I4 as the first PR                          |
| Don’t rebuild the suite        | New AMM / new account because “we own it now” |
| Don’t dual-deploy              | Second rail “just in case”                    |
| He can’t read diffs            | Needles in English + explorer links           |
| Vue isn’t Grok                 | Protocol Done claimed from `:8090`            |
| Peace of mind                  | Unnamed sockets treated as leftover software  |

---

## 6 · What this file does _not_ do

- Pick bundler vendor (plan may pick Pimlico as default).
- Allocate Sepolia ETH (ops when Phase 1 starts).
- Close `socket.clob-contracts` (audit is Class X; **public deploy** is Phase 1–2 and does not wait for the firm).
- Overrule house-book or park ADRs.

**Execution split (2026-09-18):** [`PROTOCOL-P0-EXECUTION-SPLIT-2026-09-18.md`](PROTOCOL-P0-EXECUTION-SPLIT-2026-09-18.md) — SovereignVenue `place` is part of A, not a second OMS. Fiat `svc-execution` already exists. External execute stays a socket until you name venues.

**Full spec (2026-09-18):** [`PROTOCOL-P0-FULL-SPEC-2026-09-18.md`](PROTOCOL-P0-FULL-SPEC-2026-09-18.md) — every 3P room, landscape, Must vs skip-honest. Planning reads that file, not this one alone.

**Next:** a Phase 1–4 implementation plan against the full spec, then writers. Not this file.
