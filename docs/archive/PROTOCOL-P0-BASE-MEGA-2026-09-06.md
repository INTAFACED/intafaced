# Protocol P0 on Base — mega overview (2026-09-06)

**Status:** BINDING for this wave · Nitro 2026-09-06  
**Audience:** `@shehzad002` (build) · Nitro human (Class X / now) · Nitro agents (babysit only)  
**Does not replace:** doctrine §16–§17 (end-state still own L1) · park ADR [`adr/2026-09-03-protocol-rails-until-intachain.md`](adr/2026-09-03-protocol-rails-until-intachain.md) · P0 rails [`adr/2026-08-08-protocol-plane-p0-handshake-and-rails.md`](adr/2026-08-08-protocol-plane-p0-handshake-and-rails.md) · matching dual-target [`adr/2026-08-04-matching-dual-target.md`](adr/2026-08-04-matching-dual-target.md)  
**Does replace as live queue:** LAST-MVP §4’s three-row leftover (S-01 is done). Full runway still [`SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`](SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md) — this file is the **phase overlay**, not a rewrite of every S-\* row.

**Tip at write:** `origin/main` `dd6a883b` (#4189). Re-derive.  
**Tracker at write:** 155 done / 6 ready / 24 sockets. Shehzad: 28 done, 1 ready (`socket.clob-contracts`), L1 rows parked `socket`.

This is **outcomes + honesty + phases**. Not Solidity tickets. Shehzad designs the DAG.

---

## What “mega” means here

Not a Nitro-agent swarm. Not INTACHAIN. Not fifty micro-tickets.

**Mega = the Protocol Plane becomes a real Base app a wallet can use**, using the suite already on `main`, without building our L1 this wave.

Anvil CI proofs are **not** that product. LAST-MVP’s three rows were **not** that product. Idle after #2473 is the failure this file exists to stop.

---

## Law (do not re-litigate)

1. **Two shops.** Fiat matching stays `svc-matching` → ledger post is final. Protocol never writes the ledger.
2. **P0 rail = Base.** Base Sepolia first, Base mainnet later (Class X). Anvil = CI. Not “our chain.”
3. **P1 parked.** No `svc-chain`, genesis, Cosmos, INTAEVM, canonical INTACHAIN bridge, HIP-3, HyperEVM-as-home, extra L2 “just in case.”
4. **`audited:true` stays false** until Nitro pays a firm and hash+signer match. Keep shipping.
5. **No second money book.** Protocol execution/OMS must not hold balances. Internet leverage: existing shell + ledger + `svc-*`.
6. **Shehzad owns how.** Outcomes below. Stack, PR order, contract internals, bundler vendor, foundry flags — his.

---

## Send-off law (audit 2026-09-06 — missing from first pass)

These are **overview** answers Shehzad would otherwise have to invent. Not Solidity. Binding with the park ADR.

1. **There is no IFC contract on any chain today** (D-S-12, re-checked: nothing in `svc-protocol` / `svc-indexer` contracts named IFC). Ledger IFC and chain IFC are **one supply** when a bridge exists. **This wave: do not deploy a token called IFC. Do not enable CEX ↔ chain crossing.** Testnet AMM/venue may use ETH, a mock stable, or a throwaway test token with a non-IFC name. Mint-vs-lock (handshake Q1) stays unanswered until Nitro unparks the bridge **and** the D-S-12 reconciler exists. No crossing before that reconciler — law already.

2. **This wave is doctrine 3P (P0 on rails), not §23 full sovereign banking and not 4P INTACHAIN.** Lending, crew/legacy vaults, merchant, stealth, launch already have contracts — prove them on Sepolia if they are in the suite. Do **not** treat “Revolut-on-Base” as the Done bar. Card live issuer stays `socket.live-issuer` (Nitro).

3. **Gas default already decided:** [`adr/2026-08-08-paymaster-and-bundler-policy.md`](adr/2026-08-08-paymaster-and-bundler-policy.md) — unset bundler → **user submits**; unfunded paymaster → refuse `funding_unconfigured`. Nitro funding is optional for Phases 1–4. Do not invent a sponsored retail UX.

4. **Two different OMS.** Phantom `execution.sor` (done) = Fiat algo/parent-child on the **house book**. Shehzad `socket.dex-execution` = submit to the **protocol venue**. Do not merge them. Do not put protocol fills through `svc-matching` or the ledger.

5. **Indexer / dex who-touches.** Shehzad owns venue **contracts** + making a published Sepolia address the source. `svc-indexer` adapter may be agent residual **after** he publishes ABI+address (or he does it). Agents do **not** start a second venue or dual-edit his open protocol PR.

6. **Quote asset on testnet venue:** Shehzad picks (ETH or mock stable). Not IFC. Not a named mainnet venue from `socket.dex-venue-set`.

7. **Deployer:** his own Base Sepolia key is enough to start. No keys in the repo. Mainnet keys stay Class X. Registry format already: [`adr/2026-08-08-deployment-registry.md`](adr/2026-08-08-deployment-registry.md).

8. **Already-settled ADRs he should not re-open:** matching dual-target · P0 rails · park · paymaster/bundler · deployment registry · cross-plane accounting + handshake · inheritance never platform guardian · price oracle fail-closed · dex venue-set refuse-closed. Token **economic numbers** stay owner-only ([`adr/2026-08-04-token-economics-outcomes.md`](adr/2026-08-04-token-economics-outcomes.md)).

9. **Nitro Phase 0 for send-off:** paste this file. Sepolia ETH/RPC = **use your own testnet key** unless Nitro later funds a shared deployer. That is enough to start Phase 1. Audit cheque, mainnet, external venue names — not gates.

---

## Research pass (2026-09-06) — what it changes

RAN-IT this turn (public docs / papers, not Shehzad’s private notes).

| Finding                                                                                                                                                                                                                                                                                                                     | So what for us                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ERC-4337 on Base Sepolia is commodity.** Pimlico (Alto) tutorials deploy a smart account + bundler + ERC-20 paymaster on chain id **84532** today. Alchemy/Candide exist too.                                                                                                                                             | Phase 3 does **not** wait for a research invention. Point at a live bundler. Do not hand-roll one unless Shehzad wants to.                                              |
| **Native AA (EIP-8130 / Cobalt)** is Base+OP+Coinbase work. **No Sepolia/mainnet date** (vibenet only as of 5 Sep 2026).                                                                                                                                                                                                    | Do **not** block P0 on native AA. 4337 now; native AA later if it lands.                                                                                                |
| **Flashblocks = 200ms preconf** on Base today. **Denim** (canonical 200ms blocks, replaces Flashblocks) is live on **vibenet only** — Sepolia/mainnet TBD (Base docs 1 Sep 2026). Public `sepolia.base.org` is HTTP, **no WebSocket**.                                                                                      | Venue UX may use Flashblocks if Shehzad wants; must work on ordinary blocks. Indexer needs a WS-capable provider, not the public HTTP RPC.                              |
| **June 25–26 2026 Base outages** (~116 min + ~20 min). Funds safe; **liveness** died (central sequencer). Sep 2026: Base traffic can crowd blob space for other OP chains.                                                                                                                                                  | Honest copy: Base can stall. Not a reason to start INTACHAIN this wave. Incident runbook already: kill **our relay**, never a pause/upgrade.                            |
| **On-chain CLOB on a generic EVM is not Hyperliquid.** HL is a custom L1 (~70ms blocks, claimed ~~200k orders/s). Research still treats “CLOB on Ethereum L1” as structurally hard (gas, MEV, latency). L2 median fees are tiny (~~$0.0015 in 2026 Q1 papers) — **fee is not the CLOB limiter; latency/MEV/sequencer are.** | `SovereignVenue` on Base is a **self-custody venue**, not an HFT competitor. Done bar = honest public book on Sepolia, not “we beat HL.” Fiat house book stays the CEX. |
| **Deploy/verify on Base Sepolia is boring.** Foundry (`base-forge`) + Basescan / Blockscout. Chain id 84532.                                                                                                                                                                                                                | Phase 1 is ops + registry, not new architecture.                                                                                                                        |
| **#2473 merged 2026-09-02.** Shehzad last GitHub event that day. #3746 closed by an agent 4 Sep as superseded by #3839.                                                                                                                                                                                                     | Agents do not rewrite `svc-protocol` behind him. LAST-MVP “2473 still open” is **false**.                                                                               |

Unpark L1 only on a **new Nitro GO** + S-D2 module map + not-mainnet labels. This research does **not** flip that.

---

## Already on `main` — do not rebuild

Shehzad’s Aug–Sep wave: smart accounts, passkey, recovery, session keys, paymaster **contract**, AMM, lending, escrow, router, merchant, launch/fair/NFT/RWA, stealth, crew/legacy vaults, SovereignVenue + reorg tests, audit pipeline (S-J1), CardPull seam (#2473), dex fee honesty (S-I3).

**Missing as a product:** those addresses on **Base Sepolia**, indexer on the **real venue**, 4337 **live** against that chain, execution (S-I4) without a second book.

---

## Phases

Shehzad may parallelise inside a phase. He may not skip the honesty bars. Later phases may start design work early; they do not **stamp Done** early.

### Phase 0 — Now: one check, then ship

Shehzad reads the mega, posts **three lines** on [#4199](https://github.com/Phantom-X-007/intafaced/issues/4199) (or Telegram), then deploys. No form PR. [`SHEHZAD-P0-BASE-AUDIT.md`](SHEHZAD-P0-BASE-AUDIT.md).

Agents do not write the check for him. Do not wait for an audit **firm**. Do not start `svc-chain`.

### Phase 1 — Publish the suite on Base Sepolia

**After** the three-line check. If that check is **NO**, stop and Nitro reads it.

**Needle:** a stranger can open Basescan/Blockscout, see **our** verified contracts on chain id **84532**, labelled testnet / `audited: false` / **not INTACHAIN**.

Done bar:

- Deployment registry (S-A13) holds **non-zero** Sepolia addresses + source hash. Defaults stay zero in unset env.
- Explorer verification for the suite that users will touch (accounts, AMM, venue, factory — Shehzad names the set).
- No UI or tracker implies mainnet or “our chain.”

Fail-first: a configured-env test (or public call) against a **non-anvil** RPC that fails until the registry is filled.

### Phase 2 — Venue is real (closes `socket.clob-contracts`)

**Needle:** indexer + quote path read **SovereignVenue** at the published Sepolia address. DevVenue is a fixture only.

Done bar:

- `socket.clob-contracts` can go **done** with residual named: `audited: false`, testnet only.
- Reorg behaviour already tested on anvil (#2465) — prove it still holds against the live address or say what is still anvil-only.
- Honest product line: this is a **protocol CLOB on Base**, not HyperCore.

Shehzad owns matching design on that contract. Do not spec ticks/gas here.

### Phase 3 — Account path on that chain (4337 live)

**Needle:** a UserOperation lands on Base Sepolia for **our** account implementation (not only a Pimlico Safe tutorial).

Done bar:

- Bundler URL is configured for 84532. Vendor is Shehzad’s pick (Pimlico/Alto is proven; not mandatory).
- Paymaster **contract** already refuses when unfunded (S-A10). Live: that refuse on Sepolia, **or** sponsored ops if Nitro funded the float.
- Passkey / recovery / session-key: configured-env proof on Sepolia or an honest “anvil-only residual” line. Do not rebuild S-A1.

Do **not** wait for Cobalt/EIP-8130.

### Phase 4 — User journeys on Sepolia (rooms, not tickets)

Each is a **wallet click** on Base Sepolia against published addresses. Shehzad picks order and batching.

| Room                | User-visible done                                                           |
| ------------------- | --------------------------------------------------------------------------- |
| Smart account       | Create / session-key spend / recovery path as already specified             |
| AMM                 | Mint + swap on the published pool template (**not** an IFC-named token)     |
| Launch              | Token+pool or fair-launch as already specified (test token, not IFC)        |
| Lending             | Supply/borrow or honest refuse on published markets if already in the suite |
| Stealth             | Announce + scan against published announcer                                 |
| Merchant / escrow   | One accept or escrow round-trip if already in the suite                     |
| Crew / legacy vault | One threshold spend or heir path if already in the suite                    |

Empty UI on `:8090` is **Nitro shell wiring after addresses exist** — not a reason for Shehzad to sit. Protocol Done ≠ Vue.

### Phase 5 — Execution (S-I4) · the remaining engineering mountain

**Needle:** a quoted **protocol** venue can **fill** without the platform holding the user’s tokens.

Done bar:

- OMS/submit path exists for the Protocol venue. Today adapters are quote-only and `submit()` throws — keep that loud until this is real.
- Venue Vault residuals (durable store / HSM as Shehzad specifies) — withdrawal still refused at register.
- **Must not** become a second ledger. Fills final at **chain** finality (dual-target ADR).
- Fiat house book stays `svc-matching`. This phase is **not** “move CEX matching to Base.”

This is the biggest remaining build. Shehzad specs it. Agents do not invent `svc-execution` behind him unless he asks.

### Phase 6 — Adversarial leftover (S-J2)

Reentrancy, oracle manipulation, session theft, factory griefing — **his depth**. Pipeline already refuses a fake `audited:true`. External firm remains Nitro Class X.

### Phase 7 — Base mainnet (Class X)

Only after Phases 1–4 work on Sepolia **and** Nitro writes GO (keys, gas, go-live yes). Same honesty: not INTACHAIN, `audited:false` until paid.

---

## Parked this wave (named)

`chain.mainnet` · `chain.evm` · `chain.validators` · `chain.governance` · `chain.rust-core` · `bridge.canonical` (INTACHAIN) · `predict.markets` as INTACORE type · HIP-3 · HyperEVM as home · Base Appchain/L3 · dual-deploy Arbitrum “just in case.”

S-D2 module map **written** 2026-09-18: [`adr/2026-09-18-intacore-module-map.md`](adr/2026-09-18-intacore-module-map.md). Predict resolution spec: [`adr/2026-09-18-predict-resolution-stack.md`](adr/2026-09-18-predict-resolution-stack.md). **Implement** of S-D4 stays parked.

---

## Nitro still holds (not coding gates)

| Item                                     | Why                                                        |
| ---------------------------------------- | ---------------------------------------------------------- |
| Sepolia ETH / RPC / optional bundler key | Phase 0                                                    |
| Gas-sponsorship float                    | Paymaster live sponsor                                     |
| External audit cheque                    | `socket.contract-audit`                                    |
| Named **external** venues we quote       | `socket.dex-venue-set` — different from our SovereignVenue |
| Mainnet keys / go-live yes               | Phase 7                                                    |
| Issuer keys                              | `socket.live-issuer`                                       |

Shehzad does **not** sit on Phase 1–4 waiting for the audit cheque or external venue names.

---

## Nitro agents

- **Do:** shell honesty once addresses exist; path-intersect; babysit **his** PRs; leave `audited:false`.
- **Do not:** `svc-protocol` rewrites, tracker “ready→done” for chain rows, `svc-chain`, closing his PRs as “superseded” by your recook.

Tip CI at write is **red** (`Doctrine gates` / `Format` / `Typecheck` / `Tests (full)` on #4188-class). Informational. Do not block Shehzad on it. Do not “heal main” by touching his contracts.

---

## Research still owed (all-out, not L1)

Do these **during** the phases, not as a new park:

1. **Flashblocks vs ordinary blocks** for SovereignVenue cancel/replace (Shehzad). Denim when it actually activates on Sepolia.
2. **Gas/latency of our venue** on Sepolia vs “demo” — measure, don’t claim HL numbers.
3. **Bundler SLA / permissionless mempool** on Base (OP `eth_sendRawTransactionConditional`) — Shehzad picks.
4. **IFC on Base vs ledger** — **no crossing this wave.** Existing ADRs; not a substitute P1. Do not mint “IFC.”
5. **Indexer WS provider** — public Base RPC has no WS (Aug 2026). Pick a provider; Nitro funds if paid.

Do **not** research Cosmos/HIP-3/HyperCore clones this wave.

---

## Conflict rule

If LAST-MVP, a dated board, or a tracker `ready` line says start INTACHAIN **or** says Shehzad is done after #2473, **this file + the park ADR win**.

---

## Paste — Nitro → Shehzad

```
Shizu — one page, then three lines, then go.

https://github.com/Phantom-X-007/intafaced/blob/main/docs/PROTOCOL-P0-BASE-MEGA-2026-09-06.md

Reply on https://github.com/Phantom-X-007/intafaced/issues/4199
1. GO / GO except … / NO because …
2. Anything in that plan that’s the wrong call
3. First thing you’ll ship

Hard: P1 parked (no svc-chain). Base Sepolia. Not “our chain”. No token named IFC. No CEX↔chain. User pays gas. audited:false.

NO is useful. Then ship Sepolia with your own key. Don’t wait for me.
```
