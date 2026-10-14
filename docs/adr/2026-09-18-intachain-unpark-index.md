# INTACHAIN unpark — what is written, what is left (English)

**Status:** proposed  
**Status note:** **Proposed (index).** Not a tracker recook. Not LIVE-LANES.  
**Written:** 2026-09-18. Tip at write: re-derive `origin/main`.  
**Does not unpark P1.** Nitro still writes GO on [`2026-09-03-protocol-rails-until-intachain.md`](2026-09-03-protocol-rails-until-intachain.md).

This is the remaining-pile list after leftover HMAC mill (#4267–#4273) and the 2026-09-18 spec wave. Peace of mind = these names, not a new board.

---

## Already law (do not rewrite)

| Thing                    | File                                                                                                 | Note                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Two planes, two “final”s | doctrine §16–§17 · D-S-06 [`2026-08-04-matching-dual-target.md`](2026-08-04-matching-dual-target.md) | Fiat = ledger post. Protocol = chain finality. |
| P1 parked                | [`2026-09-03-protocol-rails-until-intachain.md`](2026-09-03-protocol-rails-until-intachain.md)       | No `svc-chain`, no genesis, no mainnet stamp.  |
| S-D2 module map          | [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md)                             | Merged #4274 as spec. Implement still parked.  |
| Predict resolution       | [`2026-09-18-predict-resolution-stack.md`](2026-09-18-predict-resolution-stack.md)                   | Merged #4274. Code waits on INTACORE.          |
| Bridge **accounting**    | [`2026-08-04-cross-plane-bridge-accounting.md`](2026-08-04-cross-plane-bridge-accounting.md)         | Window ≠ one posting.                          |
| Bridge **who signs**     | [`2026-08-15-cross-plane-bridge-handshake.md`](2026-08-15-cross-plane-bridge-handshake.md)           | Platform never guardian.                       |
| Base lending oracle      | [`2026-08-08-price-oracle-fail-closed.md`](2026-08-08-price-oracle-fail-closed.md)                   | P0 / S-A12. Not INTACORE.                      |

---

## Written this wave (specs; still not implement)

| Thing                  | File                                                                                                   | What a later engineer fails a test against                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Shared matching rows   | [`2026-09-18-matching-shared-conformance.md`](2026-09-18-matching-shared-conformance.md) (#4276)       | Types, TIF, tick/lot, STP v1, price-time, determinism. Fiat pin: `services/svc-matching/src/engine/shared-conformance.pin.test.ts`.   |
| S-D3 stake bags        | [`2026-09-18-validator-stake-vs-stakeof.md`](2026-09-18-validator-stake-vs-stakeof.md)                 | `token.stakeOf` ≠ validator bond. No silent equate.                                                                                   |
| S-D5 same-block EVM    | [`2026-09-18-intaevm-same-block.md`](2026-09-18-intaevm-same-block.md)                                 | EVM must not see an unfinalized clob fill. Desync = refuse + halt.                                                                    |
| Reconciler first       | [`2026-09-18-cross-plane-reconciler.md`](2026-09-18-cross-plane-reconciler.md)                         | Compare `-balance(bridgeBoundary)` to chain figure. No crossing.                                                                      |
| INTACORE mark port     | [`2026-09-18-intacore-mark-port.md`](2026-09-18-intacore-mark-port.md)                                 | Unset/stale/disagree refuse. Min of two. Not Predict resolution.                                                                      |
| Drop-copy completeness | [`2026-09-18-dropcopy-completeness-contract.md`](2026-09-18-dropcopy-completeness-contract.md) (#4278) | Replay / gap-fill / independent session / interval. Completeness still refuses until every source **publishes**. Parallel house spec. |

If a filename 404s on the tip you opened, that PR has not merged yet — re-fetch.

---

## Remaining piles (by who)

### Nitro (human)

- **P1 GO** on the rails ADR. Without it, no `svc-chain`, no genesis, no CometBFT, no `chain.mainnet` Done.
- **Every economic number:** fees, bonds, slash, haircuts, mark staleness, disagreement bps, Predict windows/bonds, confirmation depth.
- **Class X:** mainnet keys, who may run validators, operator geo / sanctions list **content**, go-live.
- **Paid firm** before `audited: true`. A test suite is not that firm.
- **Venues** (Connect): which external venue, commercially. Agents must not invent `DEX_EXTERNAL_VENUES`.
- **HIP-3 / HyperEVM-as-home / extra L3** as INTACHAIN: still banned until a **new** GO.
- Whether Fiat and INTACORE market ids ever merge (default: no). Whether books ever share liquidity (default: no).
- Whether product `stakeOf` is ever carefully mapped to validator bond (default: never — S-D3).

### Codex (Vue desk)

- `vendor/upstream-exchange/05_Web_Front`, `packages/ui`, Vue.
- Drop-copy source **`ui`** is FRONTEND. Completeness stays incomplete until that surface actually publishes. Backend must not synthesize it.

### Shehzad (protocol)

- P0 on **Base** (anvil = CI): Sepolia addresses, venue as a real published book, 4337 against that chain. Honest labels: not INTACHAIN, `audited: false`.
- Solidity. Do not stamp audited.
- After Nitro GO + S-D2 (exists) + not-mainnet labels: S-D4 testnet skeleton, then S-D5 EVM module, S-D6 `svc-chain` ops, S-D7 chain half of the bridge (mint-vs-lock, attestation).
- S-B3 / S-B5: IFC on-chain representation and attestation design. Agents do not invent them.
- `SovereignVenue` is a P0 toy/on-chain EVM book — never `chain.mainnet`.

### Parked until GO (agents)

- `services/svc-chain`
- Genesis / CometBFT binary / mainnet stamp
- Enabling any cross-plane crossing
- Deploying a token **named IFC** on Base this wave
- Copying TypeScript matching into a validator
- Relabeling Base / anvil / HyperEVM as INTAEVM

### Sockets (named ≠ done)

- Rust matching (S-D8)
- Live card issuer, Stripe/PayPal as if they were ours, notify email/push/SMS partners
- Copy auto-mirror, MPC, VR, ledger sharding
- Options / forex **settlement assets**
- External DEX venues (Connect **execution** against a named venue)
- Price-oracle **vendor**
- Social recovery / platform-as-guardian (forbidden; stays socket)

### In flight (do not dual-edit)

- Drop-copy **ingest hitch** on `feat/svc-fix-dropcopy-hitch` (svc-fix). Completeness must stay refuse while ui/rest/ws/algo/liquidation/rfq/broker have not published. This index does not race that PR.
- Dependabot-only open product PRs at last look — not ours.

### House book — not this index’s mill

- Connect: `packages/venue-contracts` already is the contract + refusal. Building `svc-connect` against an **unnamed** venue is occupancy. One real venue is Nitro’s pick.
- Care-order / allocation: `svc-execution` already **refuses** (`care_unsupported`) and bounded TCA is read-only over the EMS journal. Do not rebuild OMS.
- Bank/PG skip ≠ green: leftover mill closed; do not recook.
- HMAC compose default stays accept-both. Production mutate doors that still need require: hardcode on **that** door.

---

## Unpark checklist (when Nitro GOs)

All of these, not a subset:

1. GO written on the rails ADR (or successor).
2. S-D2 exists — **yes** (`2026-09-18-intacore-module-map.md`).
3. Testnet labelled **not mainnet**.
4. Shared matching rows imported by the new runtime (this wave wrote the rows).
5. S-D3 non-equivalence respected (no `stakeOf` as voting power).
6. Reconciler running **before** any crossing.
7. INTAEVM same-block tests (S-D5 §6) before the name is used.
8. Mark port bound or levered markets refused.
9. `audited: true` still false until a paid firm.

---

## What this index is not

Not a mill queue. Not permission. Not LIVE-LANES. Not a recook of M00–M28. If a row above is done on tip, the file it points at wins over this paragraph.
