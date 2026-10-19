# D26-P4-02 — Cross-plane bridge handshake (ledger ↔ chain · who signs)

**Status:** Handshake recorded — 2026-08-15. **Does not** implement `svc-bridge`, protocol, or chain.
**Board:** D26-P4-02 (`docs/DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed) §8).
**Lane:** `denon-d26-p4-02-bridge-handshake`.
**Accounting law (already accepted):** [`docs/adr/2026-08-04-cross-plane-bridge-accounting.md`](2026-08-04-cross-plane-bridge-accounting.md) (D-S-12).
**Chain side (Shehzad, not this PR):** S-B5 (bridge design) · S-D7 (`svc-bridge`) · S-B3 (IFC on-chain representation) · tracker `bridge.canonical` owner `shehzad002`.
**Guardian law (already accepted):** [`docs/adr/2026-08-08-inheritance-never-platform-guardian.md`](2026-08-08-inheritance-never-platform-guardian.md) · `socket.social-recovery`.
**Tip at write:** `1723273b`. Re-derive before acting.

This note is the Denon ↔ Shehzad handshake: **one supply across two planes**, and **who may sign**. It names open questions. It does not invent attestation keys, mint-vs-lock, confirmation depth, or a rail.

---

## 1 · One supply

Doctrine §17.3: ledger IFC and chain IFC are **one supply**, reconciled by the bridge + attestations.

That conservation is **not** `totalsByAsset === 0` on the Fiat book. D-S-12 already settled this: the ledger cannot see the chain; citing the book as cross-plane proof is forbidden. The number that would matter is `-balance(treasury/bridge:<chain>, asset)` against the on-chain locked or minted figure — **not computed today**, because `bridgeBoundary()` has no callers and no service may read both books in one place.

Until the D-S-12 reconciler exists **and** Shehzad's on-chain figure exists, **no crossing is enabled**.

---

## 2 · Two languages — do not mix them

A crossing is two legs on two systems (D-S-12). Each leg speaks a different language.

| Plane                       | What moves value                                                                                            | What must never be treated as the other                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Fiat / custodial**        | `packages/ledger-client` **recipes** posted through `LedgerClient.post`                                     | A chain log, a bus event, or adapter memory                                 |
| **Protocol / self-custody** | **Protocol / chain events** that are **final** (reorg-safe source), plus attestation when that design lands | A ledger posting, `totalsByAsset`, or `svc-protocol` first-seen observation |

**Custodial recipes (named, not written).** D-S-12 keys: `bridge.<direction>.hold:<crossingId>` then `bridge.<direction>.settle:<crossingId>` **or** `bridge.<direction>.reverse:<crossingId>`. Precedent is `withdrawHold` / `withdrawSettle` / `withdrawReverse` in `packages/ledger-client/src/recipes/index.ts`. The seam account is already `bridgeBoundary(chain, asset)` → `treasury` / `bridge:<chain>`. **No `bridge.*` recipe exists on this tip.** Agents do not invent one in this handshake.

**Protocol events (consume, do not author here).** `packages/events` already reserves verb `'attested'` with no publisher. D-S-12: `svc-protocol` publishes from the first log seen — acceptable for observation, **forbidden as a bridge input**. A bridge consumes `svc-indexer`'s reorg-safe source or it consumes nothing. Shehzad owns the chain facts (S-B5 / S-D7). Agents do not open `svc-protocol` or Solidity to "complete" this handshake.

---

## 3 · Who signs (the rule)

**Settled — do not re-litigate:**

1. **The user signs for self-custody.** `SmartAccount` accepts one unrestricted signer: the user's `owner`. The platform holds no key the account recognises (svc-protocol README; doctrine §17.4 session keys never include withdrawal).
2. **The platform posts the custodial book as bookkeeper, not as chain signer.** Ledger recipes are operator/service posts against `treasury/bridge:<chain>`. That is double-entry. It is **not** a guardian signature on the user's smart account, **not** a mint/lock on-chain, and **not** an attestation vote.
3. **The platform is never a guardian.** A guardian is a second party who can take the account. No platform-controlled key is eligible; no platform quorum may move user chain funds. If a bridge or recovery design requires the platform to be that party, it **stays a socket** (`socket.social-recovery` · S-K7 ADR).
4. **Window exposure is the platform's, never the user's** (D-S-12 §3). Crash between legs: user spendable must not show value that has left; treasury carries the obligation.

**Not a signature:** watching a log, publishing a bus event, or storing adapter memory. Those are observations. Chain state after finality is the authority for the protocol leg (D-S-12 §4–§5).

---

## 4 · Open questions (named, not invented)

These stay open. This handshake does not pick them.

| ID  | Question                                                                | Who answers                                 | Status on tip                                                                                           |
| --- | ----------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Q1  | Mint vs lock for IFC on the rail (how the chain figure is defined)      | Shehzad S-B3                                | Unanswered. Spec ADR first if ambiguous.                                                                |
| Q2  | Attestation design, signer set, quorum                                  | Shehzad S-B5                                | **Zero of the keys a crossing needs exist today** (D-S-12). Verb `'attested'` is reserved, unpublished. |
| Q3  | Confirmation depth / finality number for a bridge                       | Shehzad + D-S-12 implementers               | Neither number exists in-repo for a bridge. Name it with a written reason before settle.                |
| Q4  | Which EVM rail carries Protocol P0                                      | Nitro (§0.5) via S-D1                       | Proposed in the P0 handshake ADR; not a Denon pick here.                                                |
| Q5  | `jurisdiction.ts` `bridge: OPEN_FULL` — confirm KYC tier for a crossing | Owner (D-S-12 "what still needs the owner") | Silent today; restated here as still needing a deliberate confirm.                                      |
| Q6  | Register the bridge as a human / Class X blocker                        | Nitro human                                 | Class X1 (plausibly X3) go-live. Not agent-done.                                                        |
| Q7  | Cross-plane reconciler (first deliverable before any crossing)          | Ledger plane (D-S-12 agents may implement)  | Not built. Halt-on-divergence is the gate.                                                              |

Until Q2 lands, D-S-12 stands: **a crossing is operator-gated or it does not run.** Operator-gated is not "platform as guardian." It is refuse-closed until attestation or an explicit operator gate exists. Agents do not invent multisig / optimistic / light-client theatre (S-B5).

---

## 5 · Split of work (handshake, not fight)

| Owner              | May do                                                                                   | Must not                                      |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Denon / ledger** | Recipes + reversal in `ledger-client`; reconciler vs `bridgeBoundary`; posture halt      | Solidity, `svc-protocol`, `svc-bridge` chain  |
| **Shehzad**        | S-B5 threat model + attestation; S-D7 `svc-bridge`; on-chain IFC (S-B3); finality source | Custodial second book; platform guardian keys |
| **Nitro human**    | Class X: secrets, go-live yes, rail name if still gated                                  | —                                             |
| **Agents**         | Babysit Shehzad PRs; implement D-S-12 ledger half when claimed                           | Implement protocol/chain/bridge mountains     |

`bridge.canonical` stays `owner: shehzad002`. This docs handshake does **not** claim that mountain.

---

## 6 · Non-goals (this PR)

- No `svc-protocol`, no Solidity, no Vue, no `svc-edge`, no `owner-ruling-packet.json`.
- No `svc-bridge` service, tables, events, or tests.
- No invented attestation security, signer list, or confirmation depth.
- Does not re-open D-S-12. The accounting ADR remains the law this handshake points at.

---

## Done bar (D26-P4-02)

- [x] Tip note: custodial ledger recipes vs protocol events.
- [x] Who may sign: user on-chain; platform as bookkeeper only; **never platform as guardian**.
- [x] Pointer to [`2026-08-04-cross-plane-bridge-accounting.md`](2026-08-04-cross-plane-bridge-accounting.md).
- [x] Open questions named (Q1–Q7), not invented.
- [x] LIVE-LANES row `denon-d26-p4-02-bridge-handshake` claimed (this lane only).
