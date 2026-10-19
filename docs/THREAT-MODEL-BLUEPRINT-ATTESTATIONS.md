# Threat model — Blueprint rank attestations (zero PII)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Board:** D26-P0-12 (packet law on this page) · D26-P1-I4 (Fiat refuse surface) · tracker `blueprint.attestations`  
**Packet:** `docs/ops/owner-ruling-packet.json` (removed) `D26-P0-12`. Predecessor subsection in [`adr/2026-08-14-remaining-p0-money-law.md`](adr/2026-08-14-remaining-p0-money-law.md) was not edited.  
**Bar status (helper):** **UNMET** — product Done stays refused until Denon adds the helper's P0-12 seal line after the on-chain half is specified with Shehzad. This page is the working bar, not that helper token.  
**Class:** N on the Fiat refuse; on-chain issuance is **Shehzad** (babysit only).  
**Not this page:** `THREAT-MODEL-CURRENT.md` (removed) (D26-P3-02 fiat/wallet_rpc/Java) · [`THREAT-MODEL-STAGING-DEPLOY.md`](THREAT-MODEL-STAGING-DEPLOY.md) (one workflow).

**Doctrine:** §19 (portable standing, zero PII) · §10 (PII stays in the Fiat Plane encrypted store) · §26 (unlinkable presentations; this row is the standing half, not stealth receive).

**Leverage:** Phase A IN `S-BLUEPRINT`. Horizon path for the mountain is **S** (on-chain). This document does not authorize a chain write.

Illustrative field names below are schema tokens (`rank_band`, `epoch_id`, `subject_commitment`). They are not people, emails, wallet strings, or case ids.

---

## Assets

| #   | Asset                                         | Why it ranks here                                                                                           |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | **Fiat identity / KYC store**                 | Name, documents, custodial `userId`. Putting any of it on a public attestation is irreversible disclosure.  |
| 2   | **Share card (SVG / raster DTO)**             | Acquisition artifact meant to leave the service. Must stay zero-PII or it becomes a dox vector.             |
| 3   | **Rank / Blueprint standing**                 | The only thing §19 wants to prove. Safe as a commitment or coarse rank token — not as a person.             |
| 4   | **Cross-plane chain address / smart account** | Linking a custodial user to a public address is the other half of a deanonymization pair.                   |
| 5   | **On-chain attestation contract (unbuilt)**   | Shehzad leftover. An agent-invented verifier is security theater.                                           |
| 6   | **Issuer mapping**                            | The off-chain map from subject-commitment → custodial principal must never be published or copied on-chain. |

---

## Adversaries

| Adversary                  | Goal                                                              | Why we care                                         |
| -------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Curious verifier / indexer | Reconstruct who holds which rank from public payload + chain data | Payload must not name a person or their other plane |
| Compromised Fiat caller    | Smuggle `userId` / KYC / email onto card or attestation DTO       | Machine refuse by named field                       |
| Agent inventing “done”     | Flip `blueprint.attestations` without P0-12 seal or live chain    | Product Done helper refuses; tracker stays not done |
| Cross-plane correlator     | Join KYC user to INTACHAIN / EVM address via the attestation      | Cross-plane address keys refuse by name             |

---

## Trust boundaries

| Boundary                        | Trusted side                          | Untrusted side                                 | What must not cross                             |
| ------------------------------- | ------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Fiat profile store → share card | Derived axes, crew public name        | Session answers, birth data, `userId`, KYC     | Identity / KYC / custodial id                   |
| Fiat issuer → attestation DTO   | Rank / crewRole / season / commitment | Email, handle, KYC status, wallet / SA address | Same plus cross-plane address                   |
| Fiat → Protocol Plane           | Commitment only (when Shehzad builds) | Encrypted PII store, identity APIs             | Any field that identifies a natural person      |
| Card rasterizer                 | SVG we composed                       | Hosted PNG URL consumer                        | SVG must already be zero-PII                    |
| Verifier → KYC APIs             | —                                     | —                                              | **No call.** Third-party verify without our KYC |

---

## Zero-PII bar

A card or rank-attestation payload **refuses by named code** if it carries:

| Category            | Refuse code                                     | Example keys                                  |
| ------------------- | ----------------------------------------------- | --------------------------------------------- |
| Identity            | `blueprint.attestation_pii_identity`            | `email`, `legalName`, `handle`, `birthData`   |
| KYC                 | `blueprint.attestation_pii_kyc`                 | `kyc`, `kycStatus`, `kycDocument`             |
| Custodial user id   | `blueprint.attestation_pii_custodial_user_id`   | `userId`, `custodialUserId`, `customerId`     |
| Cross-plane address | `blueprint.attestation_pii_cross_plane_address` | `walletAddress`, `evmAddress`, `smartAccount` |

Allowed attestation keys (Fiat DTO only): `schemaVersion`, `kind`, `rank`, `crewRole`, `season`, `commitment`.  
Share card DTO stays `cardRenderSchema` — no `userId` on the wire object.

WebAuthn authenticator attestation in `svc-identity` is **a different product**. Do not conflate.

Fail the schema, the PR, and the product Done claim if **any** of these exist in the signed payload, issuance logs, events, or indexer projection:

### Identity (never)

Legal name, chosen display name, unique handle, email, phone, government id, biometric template, photo, or any stable identifier of the custodial user (`userId`, account number, session subject, Blueprint profile id in the clear).

### KYC (never)

KYC status flags that identify a person, document hashes, vendor case ids, jurisdiction-of-residence as a personal attribute, or any artefact from the §10 encrypted store. Services on the Fiat Plane may see **status flags** for their own gates; those flags **do not** enter an attestation.

### Addresses that link planes (never)

Custodial deposit/withdraw addresses, Fiat Plane account ids encoded as “wallets”, the same smart-account address used as the KYC-bound withdrawal target, emails-as-handles, or any address that lets an observer join Protocol Plane standing to a Fiat Plane person. §26 stealth receive is the unlinkable _receive_ half; this bar forbids using attestation fields to do the join anyway.

### Quasi-identifiers we refuse rather than “hash and hope”

IP, geo, device id, user-agent, and unique perk/crew combinations that are effectively a fingerprint. Hashing PII and putting the hash on-chain is still PII if the preimage space is small or the issuer mapping is public.

**No “optional PII” fields.** Optional is how a convenience field becomes permanence.

---

## Product Done

**Refuse.** `decideAttestationProductDone` returns `blueprint.attestation_threat_model_unmet` until this file contains the helper's P0-12 seal line **and** the headings above. Tracker `blueprint.attestations` stays `ready` / owner `shehzad002`. On-chain leftover: Shehzad (`protocol.smart-accounts` + issuance). Agents do not mark the mountain done from D26-P1-I4.

When (later) the bar is sealed, product Done still requires live issuance on a real chain decision — not anvil-only theater, not this PR.

---

## What an attestation may prove (rank / standing)

Allowed in the signed payload, and in any public projection of it:

| Field kind                                                  | Meaning                                            | Constraint                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `schema_id` / `issuer_key_id`                               | Which law and which issuer key signed this         | Platform identifiers, not a person                                                                                     |
| `epoch_id`                                                  | Named standing window                              | Verifier refuses stale epochs                                                                                          |
| `rank_band`                                                 | Discrete standing already computed off-chain       | Band / tier token only — not a score history, not a balance, not a fill list                                           |
| `expires_at`                                                | Attestation lifetime                               | Required; replay of an old band fails                                                                                  |
| `subject_commitment` or nullifier / one-time serial         | Binds the proof to a subject without naming them   | Must not be joinable to the custodial principal without the issuer’s **private** mapping, which must not live on-chain |
| Optional: crew / perk **commitment** or entitlement bitmask | Standing-derived perks that do not encode a person | No crew display name, no member list, no perk that is unique to one human                                              |

**That is the prove-set.** Rank and Blueprint standing. Not identity. Not KYC. Not money.

Crew names, mentor identity, curriculum, and share-card art stay Fiat / shell. They are not attestation fields.

---

## Threats and required answers

| Threat                                    | Required answer                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Payload or projection deanonymises a user | Schema reject. Zero-PII bar.                                                                                     |
| Cross-plane join via an address or id     | Forbidden field class. Stealth receive is not this row.                                                          |
| Replay of an old rank                     | `epoch_id` + `expires_at`; verifier refuses stale.                                                               |
| Caller inflates rank                      | Issuer signs; caller cannot choose `rank_band`.                                                                  |
| Issuer key compromise                     | Rotation + expiry; old `issuer_key_id` stops verifying.                                                          |
| Fiat erase vs chain permanence            | Never put §10 store contents on-chain; erase cannot unsay a public payload.                                      |
| Fake product Done / UI badge              | Until a deployed verifier meets this bar, surfaces stay a **socket**. No invented JSON badge in `svc-blueprint`. |
| WebAuthn conflation                       | Forbidden. Passkey attestation is a different product.                                                           |
| Unique serial that is the person          | Nullifier / one-time serial must not be the custodial id or a public hash of one.                                |

---

## Refuse if the bar is unmet

Implementers and agents **must refuse** (typed residual, not a default payload) when:

1. The schema includes a forbidden field, including “optional”.
2. Issuance would read the §10 PII store into the payload.
3. The verifier would need a KYC API to decide validity.
4. `protocol.smart-accounts` (or the chosen chain attestation suite) is unconfigured — honest unavailable, not a theatre badge.
5. Anyone proposes to mark tracker `blueprint.attestations` **done** without a live verifier that meets this bar (not anvil-only).

**D26-P1-I4** (on-chain implement) stays blocked on this law **and** on Shehzad’s smart-account path. Shell agents do not close it.

---

## Explicit non-goals

- No `svc-protocol` / contract work in this law page.
- No Vue / shell “attested” chrome.
- No invented attestation standard, gas sponsor, or mainnet.
- No `features.mjs` status flip.
- No real PII in docs or fixtures.

---

## Packet ruling (D26-P0-12)

> **A Blueprint attestation may prove discrete rank/standing for a named epoch under an issuer key. It must never contain identity, KYC, or addresses that link Fiat and Protocol planes. If that bar is unmet, issuance and product Done refuse. On-chain implement remains Shehzad.**
