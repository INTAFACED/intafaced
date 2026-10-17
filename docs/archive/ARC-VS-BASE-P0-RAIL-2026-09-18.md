# Arc vs Base — is the parked-L1 cheap rail still Base?

**Status:** Research briefing for Nitro · **2026-09-18** · **not a GO** · does not unpark INTACHAIN · does not change P0 rails until you say so  
**Tip at write:** `origin/main` `63be8aa12`  
**Question:** Circle’s Arc L1 launched public mainnet **16 Sep 2026**. Should Protocol P0 move off Base?

**Verdict:** **No.** Keep the agreed cheap path: **house book for trading + Protocol contracts on Base (Sepolia → Base, anvil = CI).** Arc is a **Circle consortium chain**, two days old. It is **not** INTACHAIN, **not** a cheaper own-L1, and **not** a better Protocol home for this wave. Watch it. Do not switch.

---

## 0 · What you actually decided (re-derived this turn, not memory)

Three different jobs got mixed in chat as “the chain.” They are not one pile.

| Job                | What it is                                          | Law on tip                                                                                  | Who                             |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| **House exchange** | Matching, bank, pay, ledger                         | Fill is final when **ledger posts**                                                         | Agents. Running.                |
| **Protocol P0**    | Self-custody contracts on **someone else’s EVM**    | **Base Sepolia → Base.** Anvil = CI. Honest label: **not** INTACHAIN. `audited: false`      | Shehzad (idle since **2 Sep**). |
| **INTACHAIN P1**   | **Our** L1 + in-validator book (INTACORE) + IFC gas | **Parked 3 Sep** until your GO. No `svc-chain`. Specs exist (S-D2+). End-state **not cut**. | Nobody codes it until GO.       |

**The cheap solution you already agreed** (8 Aug + 3 Sep):

1. Do **not** spend years/money standing validators, genesis, and a matching L1 until the product is scaling.
2. Trading stays the **house book**. Do not move matching onto Base, Arc, HIP-3, or HyperEVM.
3. Protocol (wallets, AMM, escrow, venue contract, card pull) ships as Solidity on a **proven EVM**: **Base**.
4. Do **not** stamp that deploy “our chain.”
5. Banned until a **new** GO: HIP-3, HyperEVM-as-home, **a second L2 “just in case.”**

Sources (tip): `docs/adr/2026-08-08-protocol-plane-p0-handshake-and-rails.md` · `docs/adr/2026-09-03-protocol-rails-until-intachain.md`.

**Unspoken needs this briefing treats as the test** (inferred, then used):

1. Don’t burn L1 money until scale.
2. Don’t **fake** an own-chain by relabelling Coinbase or Circle.
3. Still need **some** EVM so self-custody DeFi isn’t theatre.
4. Trading and Protocol stay **two planes** (two words for “final”).
5. Don’t dual-deploy “just in case.”
6. Don’t pick a rail where **Circle freeze = cannot pay gas = cannot transact**.
7. Don’t pick a rail that makes **IFC-as-gas** a joke (USDC-as-gas is Circle’s dollar, not IFC).
8. Don’t port money contracts onto a **18-decimal vs 6-decimal same-USDC** footgun without a dedicated program.
9. Shehzad going quiet ≠ switch rails.
10. Completeness: name every leftover, don’t leave a silent hole.

---

## 1 · What Arc actually is (docs + independent, 18 Sep 2026)

Circle’s own docs (`https://docs.arc.io/arc-chain`, `llms.txt`, connect / gas / EVM-differences / stablecoin-native / consensus / terms):

| Fact                | Value                                                                                             | Tag                                         |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Public mainnet      | **16 Sep 2026**                                                                                   | APP (The Block 16 Sep)                      |
| Chain ID            | Mainnet **5042** · testnet **5042002**                                                            | DOC (connect-to-arc)                        |
| RPC                 | `https://rpc.mainnet.arc.io`                                                                      | DOC                                         |
| Gas                 | **USDC**, native **18 decimals**; ERC-20 view **6 decimals**, same balance                        | DOC                                         |
| Consensus           | Malachite (Tendermint BFT), **permissioned Proof-of-Authority**                                   | DOC                                         |
| Execution           | Reth, EVM (Osaka). Solidity ports, with listed traps                                              | DOC                                         |
| Finality            | Deterministic, **&lt;1 s**, no reorgs by construction                                             | DOC (Circle claim)                          |
| Who produces blocks | Named institutions **plus Circle**. You can run a **full node**, not a validator                  | DOC                                         |
| Freeze              | Circle **may freeze USDC** at an address; that address **cannot pay gas**, so **cannot transact** | DOC (Arc terms of use)                      |
| Blocklist           | Native transfers to/from blocklisted addresses **revert**; still consume gas                      | DOC                                         |
| Privacy             | Opt-in APS — **planned / not network-wide live**                                                  | DOC + The Block                             |
| `llms.txt`          | Still says “currently available on Testnet only”                                                  | DOC **stale vs** connect-to-arc Mainnet tab |

Independent (not Circle):

- **The Block 16 Sep:** mainnet live; 10 billion ARC minted; **not** a public token launch; PoS “explored for 2027”; DTCC tokenization **H2 2027**.
- **Aave Labs 14 Sep (pre-mainnet):** permissioned PoA; **five** validators can **halt** finality; **nine** can take ⅔; validator keys **not** mapped to named institutions in public; single execution client + single consensus client.
- **The Defiant / Cochran:** “this isn’t an L1… private consortium.”
- **CoinDesk 17 Sep:** day-one flow was **memecoins**, not payments (~7.8M txs / ~624k USDC transfers “over the chain’s entire life” as reported). Circle VP posted a memecoin image.

**What Arc is not:** a Hyperliquid-class book, an IFC chain, an open validator set, or a drop-in for INTACHAIN.

---

## 2 · Score vs the job (not vs the pitch)

### A · Own L1 / INTACHAIN (parked)

Arc **fails** this job. It is Circle’s chain, USDC gas, permissioned validators, no native CLOB. Using it as “we have INTACHAIN” is the **exact stamp lie** the 3 Sep ADR forbids (same class as stamping Base).

### B · Cheap Protocol P0 rail (the agreed substitute)

| Need                      | Base (agreed)                                                              | Arc (new)                                                                         |
| ------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Proven in production      | Years; Coinbase L2; huge DeFi                                              | **Two days** of public mainnet                                                    |
| EVM / our Solidity        | Yes. Suite already written for this family                                 | Mostly yes, **with money traps** (18 vs 6 USDC, freeze, `SELFDESTRUCT`, no blobs) |
| Who can halt / censor you | Coinbase sequencer + Ethereum exit story                                   | Circle + ~11 institutions; freeze **kills gas**                                   |
| Gas UX                    | ETH (annoying)                                                             | USDC (actually nicer for payments)                                                |
| IFC story                 | Neutral (ETH gas, USDC as a token via CCTP)                                | **Hostile** — the chain’s native asset **is** USDC                                |
| Dual-deploy cost          | Already the named home                                                     | A **second rail**. Park ADR **bans** “just in case”                               |
| Shehzad path              | Mega already says Sepolia on Base                                          | Restart the rail, ports, registry, indexer                                        |
| CLOB                      | Neither is INTACORE. SovereignVenue is a **toy EVM book** on whichever EVM | Same. Arc does not give us a book                                                 |

**USDC gas is the only real Arc win for us.** We already get USDC **on Base** (Circle CCTP). We do not need Circle to also own the validator set to hold dollars.

### C · “Maybe later, as a payments adapter”

Allowed as a **named later** — same class as HyperEVM “optional liquidity tap,” **not** home. Requires a new Nitro line, not a silent swap. Not this week.

---

## 3 · Why Base is still the best cheap rail

1. **It is already law.** Switching is a new GO, not a research patch.
2. **Our contracts exist for that family.** Idle Shehzad is a people problem, not a Base problem.
3. **Arc’s freeze is worse than Base’s sequencer.** On Arc, Circle freeze ⇒ no gas ⇒ account dead. On Base, USDC can be frozen **as a token**; you can still pay ETH gas and exit other assets.
4. **18 vs 6 decimals is a money-class bug farm.** Doctrine: no money in a `number`; decimal strings. Dual views of one balance off by 10¹² will mint lies.
5. **Day-one reality is memecoins**, not BlackRock settlement. DTCC assets are **2027**.
6. **Docs disagree with themselves** (`llms.txt` still “testnet only”). Too early to bet Protocol home.
7. **Park spirit:** we parked own-L1 because it is expensive. Arc does not make us cheaper; it makes us a **Circle tenant**.

**Flip to Arc-as-home only if all of:** you explicitly GO a P0 rail change · you accept Circle freeze = cannot transact · you fund a dedicated 18/6 port + indexer rewrite · Base becomes unusable for USDC · you are **not** pretending this is INTACHAIN.

**Flip to unpark INTACHAIN only if:** you write GO on the 3 Sep ADR (scale/money, not “Arc launched”).

---

## 4 · Leftovers named (so this file is complete)

- INTACHAIN implement: still parked.
- Shehzad P0 Sepolia: still not posted on [#4199](https://github.com/Phantom-X-007/intafaced/issues/4199).
- `socket.clob-contracts`: venue exists, **not** externally audited, **not** a public Base address.
- IFC: **no** on-chain IFC contract. Do not deploy one on Arc or Base this wave.
- Arc: watch item only. No `PROTOCOL_CHAIN_ID=5042`. No dual-deploy.
- This briefing is **not** an ADR. P0 rails stay Base until you overrule 8 Aug in writing.

---

## Sources

**Law (tip):** P0 rails ADR 2026-08-08 · park ADR 2026-09-03 · S-D2 2026-09-18.

**Arc first-party:** [docs.arc.io/arc-chain](https://docs.arc.io/arc-chain) · [llms.txt](https://docs.arc.io/llms.txt) · connect-to-arc · gas-and-fees · evm-differences · stablecoin-native-model · consensus-layer · terms of use.

**Independent:** The Block 16 Sep 2026 · Aave Labs technical assessment 14 Sep 2026 · The Defiant / Cochran · CoinDesk 17 Sep 2026.
