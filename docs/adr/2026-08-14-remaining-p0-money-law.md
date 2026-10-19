# ADR: remaining Denon P0 money-law seals (2026-08-14)

**Status:** **Accepted — 2026-08-14.**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-04 · D26-P0-12 · D26-P0-13 · PKT-C7 · PKT-C8 · PKT-C9.  
**Index:** `docs/ops/owner-ruling-packet.json` (removed).  
**Does not invent:** token emission/buyback/burn/staking magnitudes, insurance target size, D3 ladder, DEX vendor names, Class X secrets, F10 Java edits, Shehzad chain code.

---

## What this sitting is (and is not)

Tip already holds the engine-unblocking seals from 2026-08-12/13: house-desk fairness, dex empty-set refuse, options/forex refuse matrix, listing policy, leverage freeze, KYB grant shape, recipe matrix, house commission, scanner inputs, copy geo mechanism, marketing-language gate, insurance empty → no list, copy/affiliate/profit-pot numbers in `.env.example`.

This ADR closes the **remaining Denon product-law holes**. Nitro still holds go-live, secrets, licences, and any magnitude not already published. Shehzad still holds on-chain implement. Agents do not wait on Shehzad to keep wiring the custodial shell.

---

## D26-P0-04 — Token emission / buyback authority live

> **`token_params` (DB) is the only live authority. Source constants are seeds. Drift between seed and DB refuses. Buyback claims the revenue window first, then burns — never burn-then-guard.**

Claim-before-burn is already on tip (`recordBuybackInner` → `claimBuybackWindow`). This seal forbids reverting that order and forbids publishing user-facing emission/APY/buyback figures from seed files.

**Magnitudes stay PKT-C9 / Nitro.** A populated store with owner-set numbers is a later click, not an agent fill.

---

## D26-P0-12 — Attestation threat model (`blueprint.attestations`)

On-chain implement stays **Shehzad**. This is the law a chain PR must satisfy. Agents must not ship a PII-leaking “attestation” in the shell to close the tracker row.

### What an attestation may prove

Rank **band** (or equivalent discrete standing already computed off-chain by identity/blueprint) for a **named epoch**. Not a name, not a balance, not a trading history.

### Zero-PII bar (fail the PR if any field exists)

Forbidden in the signed payload, logs, events, and indexer projection: legal name, email, phone, government id, userId, account handle, IP, geo, device id, or any stable identifier that links to the custodial user.

Allowed: epoch, rank band, issuer key id, expiry, and a **nullifier / one-time serial** that cannot be joined to the person without the issuer’s private mapping (which must not live on-chain).

### Threats this bar is for

| Threat                          | Required answer                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Payload deanonymises a user     | Schema reject. No “optional PII”.                                               |
| Replay of an old rank           | Epoch + expiry; verifier refuses stale epochs.                                  |
| Rank inflation by the caller    | Issuer signs; caller cannot choose the band.                                    |
| Issuer key compromise           | Rotation + expiry; old key id stops verifying.                                  |
| Conflating WebAuthn attestation | Forbidden. Passkey `attestationObject` is a different product (`svc-identity`). |

Until Shehzad lands a verifier that meets this bar, the product surface stays a socket. Inventing a JSON badge in `svc-blueprint` is not closing the row.

---

## D26-P0-13 — Launchpad raise economics (law only)

> **Raise math is refuse-closed until Nitro publishes named params in an authority store. On-chain implement is Shehzad. Agents never invent caps, vest cliffs, or stake-tier allocations.**

**Catalog (2026-08-15):** named params vs sockets live in [`2026-08-15-launchpad-raise-economics-law.md`](2026-08-15-launchpad-raise-economics-law.md). This section’s refuse still binds. Empty store → typed refuse, not a default curve. Staking _gates_ may exist; they do not imply a live raise.

---

## PKT-C7 — Dark-feed horizon + operator adjudication

Amends [`2026-08-07-futures-exit-when-the-feed-is-dark.md`](2026-08-07-futures-exit-when-the-feed-is-dark.md) “what still needs the owner”.

> **A `closing` position may be settled by a human operator at an adjudicated price if the feed has stayed unusable past that market’s existing `liquidationMaxAgeSeconds`. Never a job. The adjudicated price, author, and reason are recorded on the row. Auto-settle stays forbidden.**

Horizon for the **operator alert** reuses `MarkPolicy.liquidationMaxAgeSeconds` — no second invented clock. Profit still cannot pay on an unusable mark (parent futures-risk ADR). Agents may build the human door; they may not invent a price or a bot that clicks it.

---

## PKT-C8 — `p2p:moderate` scope split

> **Do not mint `p2p:moderate` onto sessions.** Moderation is `admin:compliance` **or** a natural-person id on `P2P_MODERATOR_USER_IDS`. Empty allowlist → `p2p.moderation_unreachable`. Machine keys never moderate.

The scope split is **not required** given the allowlist. Waiting on a new session scope was blocking nothing real. Class X still owns _who_ is on the list.

---

## PKT-C9 — Four token numbers

> **Emission, buyback, burn, and staking magnitudes stay unpublished.** User-facing copy and live APY/supply claims refuse until Nitro writes them into `token_params`. Seeds in `economics/*.ts` are not those numbers.

Ties P0-04. No agent-chosen 40/60 split, cap, or APY.

---

## Still not Denon (leave them)

| Id                                         | Why                                                    |
| ------------------------------------------ | ------------------------------------------------------ |
| PKT-D10 F10 `act/pom.xml`                  | Unreviewed Java; Denon does not touch it. Nitro human. |
| CLASS-X-\*                                 | Secrets, licences, sanctions **content**, go-live.     |
| GH-G1…G3, G5                               | GitHub admin.                                          |
| Shehzad chain / INTACHAIN / smart-accounts | Babysit only.                                          |

---

## What agents may do without asking again

- Honour claim-before-burn and seed↔DB drift refuse in `svc-token`.
- Build a human futures-adjudication door that records price/author/reason and refuses jobs.
- Keep P2P moderation on the allowlist path; do not mint `p2p:moderate`.
- Refuse launchpad raise and token magnitude surfaces when the authority store is empty.
- Implement attestation **only** on the protocol plane under Shehzad, against this threat model.

## What they must not do

- Invent token or launchpad numbers.
- Put PII in an attestation payload.
- Auto-settle frozen perps.
- Name a DEX vendor in shipped defaults.
- Edit `vendor/upstream-exchange/01_wallet_rpc/act/pom.xml`.
