# Protocol P0 — what “execution” actually is (spec before plan)

**Status:** Binding for the Phase 1–4 plan. Closes a thin/outdated hole.  
**Date:** 2026-09-18  
**Tip at write:** `origin/main` `79146921e`  
**Does not:** unpark INTACHAIN · move the house book · invent a second ledger · start Sepolia this file.

Parent: [`PROTOCOL-P0-TAKEOVER-CALIBRATION-2026-09-18.md`](PROTOCOL-P0-TAKEOVER-CALIBRATION-2026-09-18.md).

---

## Decision

S-I4 / “mountain B” as written on the Shehzad board and in the mega **mashed three different jobs**. Planning them as one OMS rebuild is the failure.

| Job                                 | What it is                                                                                                                        | This wave                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Sepolia product**             | Publish the suite that **already exists** on Base Sepolia and prove it                                                            | **Do this**                                                                                                                                   |
| **P — Protocol self-custody trade** | User smart account `deposit` / `place` on **SovereignVenue**. Contract already holds base+quote. Platform never holds the tokens. | **Part of A** (Phase 2–4). Missing from the mega’s Phase 4 room table — that is the thin spec.                                                |
| **X — External venue execute**      | Place on Binance/etc. via Connect + Venue Vault keys                                                                              | **Socket** until you name venues (`socket.dex-venue-set`). Fiat `svc-execution` **already exists** (tracker `execution.sor` done 2026-08-22). |
| **L1 — INTACHAIN**                  | Own validators + in-validator book                                                                                                | **Parked**                                                                                                                                    |

`svc-dex.submit()` staying loud-refuse is still correct for **X** until venues are named. It is **not** a reason to rebuild `svc-execution`. It is **not** how SovereignVenue trades (the user sends a chain tx).

---

## Why the old text is stale

- Board S-I4 and tracker `socket.dex-execution` still say “`svc-execution` does not exist.” **False.** The service is on tip; that is the **Fiat** OMS/SOR.
- D-S-18 (4 Aug) still says `svc-execution` does not exist. **False** for Fiat. Protocol fill was never supposed to be that service holding keys.
- Mega Phase 4 lists account / AMM / launch / lending / stealth / merchant / vaults — **not** “place on SovereignVenue.” That is the hole that made B look like a second mountain.
- Venue Vault is **external API keys** (Connect). Using it as the path to _our_ on-chain book would be a custody lie.

---

## Protocol fill (job P) — enough spec to plan

**Already true in `SovereignVenue.sol`:** one market per deploy; `deposit` then `place`; fills only from matching; 18-dec amounts; taker fee from venue; no pause/guardian; `audited` false.

**Still to prove (this is A, not a new contract):**

1. Quote asset on Sepolia = **ETH or a mock stable named not-IFC**. Pick in the Phase 1 plan. Default: mock stable so we do not pretend ETH is IFC.
2. Registry row for the venue + tokens. Indexer `INDEXER_VENUE_ADDRESS` = that row. DevVenue fixture-only.
3. One UserOp (or plain tx from the SA) that `deposit`+`place` lands on 84532. Needle: explorer fill/place, not anvil-only.
4. Labels: testnet, not INTACHAIN, `audited:false`.

No platform OMS. No ledger post. Finality = the Sepolia tx.

---

## A vs “B” in parallel

| Work                               | Wait on public Sepolia?                          |
| ---------------------------------- | ------------------------------------------------ |
| Foundry deploy + verify + registry | **Is** A                                         |
| UserOp `place` against **anvil**   | No. Can run beside deploy.                       |
| Indexer pointed at Sepolia address | Yes — needs Phase 1 address                      |
| Stamp “venue live”                 | Yes — needs 1+2+3                                |
| Rebuild Fiat `svc-execution`       | **Do not**                                       |
| External execute (job X)           | Independent of A; still socket until venue names |
| L1                                 | Independent and **parked**                       |

So: **do not finish all of A before writing the place path.** Do **not** claim protocol trading Done without the published address. That is the only serial bar.

---

## Is A “all the on-chain work we wanted”?

**For this wave (doctrine 3P, cheap rail):** yes, if Phase 4 **includes SovereignVenue place** and we do not pretend X/L1 are in scope.

**Still not in A (named, not forgotten):**

| Item                            | Status                                          |
| ------------------------------- | ----------------------------------------------- |
| INTACHAIN / S-D4–D9             | Parked. Specs exist (S-D2+). No code.           |
| Predict                         | Resolution **specced**. Code waits on INTACORE. |
| IFC on-chain + canonical bridge | Forbidden this wave                             |
| Paid audit / `audited:true`     | You                                             |
| Base mainnet                    | You, after Sepolia                              |
| Live card issuer                | Socket                                          |
| External venue names            | You (`socket.dex-venue-set`)                    |
| Vue desk                        | Codex, after addresses                          |

**Spec remaining before plan mode:** quote-asset pick (ETH vs mock) and Phase 4 must-list (venue place is mandatory; other rooms already in the suite are prove-or-honest-skip). Bundler default = Pimlico on 84532 unless the plan names a better live one.

---

## Refuse

| Situation                                              | Answer                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| New TypeScript matching engine “for Base”              | No. House book stays `svc-matching`. Venue is the contract. |
| Platform holds user tokens to “execute” SovereignVenue | No. That is a second book.                                  |
| `PROTOCOL_CHAIN_ID=5042` (Arc)                         | No                                                          |
| Stamp Sepolia INTACHAIN or audited                     | No                                                          |
| Dual-deploy “just in case”                             | No                                                          |
