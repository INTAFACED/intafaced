# TRK-blueprint.attestations — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `blueprint.attestations`  
**Title:** On-chain rank attestations, zero PII (§19)  
**Module / phase:** `blueprint` · phase 4 · plane B  
**Status on tip:** ready · **owner:** none  
**Depends on:** `blueprint.onboarding` (done), `protocol.smart-accounts` (Shehzad M2 wip/ready)  
**Requires:** no dedicated package yet; future protocol + identity/rank linkage  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. A user can prove **rank / Blueprint standing on-chain** via an attestation that contains **zero PII** (no name, email, government id, handle that de-anonymizes) — §19 portable sovereign identity.
2. Attestation content is derived from Fiat Plane truth (rank service / blueprint id commitment) without leaking encrypted PII store contents.
3. Verification is possible by a third party (contract or verifier) without calling our KYC APIs.
4. Issuance path never holds user keys if smart-account based; unsigned build or account-abstracted flow only — no custodian mint of identity.
5. No fake “attested” badge in UI when chain / factory / SA suite is unconfigured.

---

## 2 · Current code state (tip)

### 2.1 Not built as product

| Fact                                | Tip                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| On-chain rank attestation contracts | **None** under `services/svc-protocol` for Blueprint rank attestations                                                       |
| WebAuthn “attestation”              | Identity passkey enrolment uses WebAuthn attestation format `none` — **unrelated** to §19 rank attestations; do not conflate |
| Events catalog                      | subject token `attested` exists in event subject grammar; no Blueprint attestation publisher product                         |
| Depends                             | `protocol.smart-accounts` is **Shehzad M2** — agents babysit only for SA deploy/audit                                        |
| Blueprint service                   | Onboarding, card SVG, crews, export/erase exist; **no** chain attestation emit                                               |

### 2.2 Plane split

Fiat Plane holds PII encrypted (§10). Protocol Plane holds **standing without disclosure**. Crossing the planes wrongly (putting email on-chain) is a permanent privacy failure.

---

## 3 · Doctrine constraints

| Law            | Implication                                                             |
| -------------- | ----------------------------------------------------------------------- |
| §19            | Zero-PII attestations for rank/Blueprint                                |
| §10            | PII never leaves Fiat encrypted store onto chain                        |
| §0.6 / custody | No ledger balances for “attestation points”; not money                  |
| Protocol SA    | Issuance likely via smart account / session path — Shehzad SA ownership |
| Class X        | Any real mainnet deploy + key ceremony not agent-done                   |

---

## 4 · DoD sketch (checkable — staged)

### Stage 0 — design (this pack)

- [x] Research notes: content fields, null PII proof, dependency on SA
- [ ] Denon/Shehzad threat model: what fields are safe (rank tier hash, crew commitment, nullifiers)

### Stage 1 — contracts + verifier (Shehzad / protocol lane)

- [ ] Attestation schema + contract or EIP-style attestation under protocol plane
- [ ] Verifier pure function tests; fails closed when suite not deployed

### Stage 2 — issuance service

- [ ] Fiat-side issuer reads rank/blueprint, emits **commitment only**
- [ ] UI shows honest unconfigured state when chain off

**Tracker `done`:** live issuance on a real chain decision + zero-PII property tests — not anvil-only theatre.

---

## 5 · Open questions

1. Attestation standard (EAS, custom SA module, INTACHAIN native) — chain decision?
2. Which fields: rank tier only vs crew vs perks bitmask?
3. Revocation on hard-delete / rank decay?
4. Who pays gas — user SA vs sponsored — product law?

---

## 6 · Estimated size

| Slice                | Size          | Notes                        |
| -------------------- | ------------- | ---------------------------- |
| Spec + threat model  | **S** Class N | This pack                    |
| Contracts + verifier | **L**         | Protocol / Shehzad adjacency |
| Issuer service       | **M**         | After SA usable              |
| Full product         | **XL**        | Multi-plane                  |

**First implement PR:** **docs only** until SA deploy path + product field list. Agents do **not** invent attestation security theater (Shehzad board S-B5 spirit applies).

**Human blockers:** protocol.smart-accounts; Product field list; Chain decision.

---

## 7 · Related docs / code

- Doctrine §19 / §7 Blueprint + §10 PII
- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`
- `services/svc-blueprint`
- `services/svc-protocol` smart accounts

---

## 8 · Explicit non-goals for this pack

- No putting email/name/handle on-chain “for convenience.”
- No conflating WebAuthn attestation with §19 rank attestations.
- No implement on Shehzad SA contracts under this research claim.
- No features.mjs done flip.
