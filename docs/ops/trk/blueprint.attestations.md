# TRK-blueprint.attestations — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `blueprint.attestations`  
**Title:** (tracker) Blueprint attestations residual — verify pack against `features.mjs` before implement  
**Module / phase:** `blueprint`  
**Status on tip:** re-derive in `features.mjs` (blueprint cluster largely advanced)  
**Tip freeze:** `origin/main` @ `56696496`  
**Pack type:** research only — do not invent WebAuthn or blueprint card URLs.

---

## 1 · What “done” means (plain language)

1. Any “attestation” product promise in tracker is **named** and checkable (blueprint session attest vs WebAuthn authenticator attest — do not conflate).
2. Blueprint profile / card / crew paths already strong on tip are **not** re-built as false residual.
3. Missing attestation slice (if any) is isolated with tests — no fabricated share assets.

---

## 2 · Current code state (tip) — do not double-build

### 2.1 Blueprint service (largely shipped)

| Tracker                | Honest tip state (from tracker notes / code)                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `blueprint.onboarding` | `svc-blueprint` mounts tRPC with edge-verified principal                                                                   |
| `blueprint.card`       | SVG compose pure; PNG rail may be **unconfigured** (`blueprint.card_renderer_unconfigured`) — never fabricate og:image URL |
| `blueprint.crews`      | Matching pure + Postgres capacity; re-score done                                                                           |
| `blueprint.ownership`  | Export + hard delete cascade — #229 era shipped (verify note)                                                              |

### 2.2 “Attestation” word collision

| Meaning                                | Where                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| WebAuthn **authenticator** attestation | `services/svc-identity` `webauthn.ts` — format **`none`** only; not blueprint product |
| Blueprint session / profile integrity  | Blueprint module — profile JSON + export                                              |

This pack’s job is to prevent an agent from “implementing attestations” by pasting WebAuthn into blueprint or inventing card PNGs.

### 2.3 Residual candidates (re-derive)

- Raster card renderer URL when `BLUEPRINT_CARD_RENDERER_URL` set — infrastructure residual, not invent.
- Any tracker row still `ready` for attestations-specific product — confirm `features.mjs` text before craft.
- Academy consumption of `crewMemberCreated` — academy residual, not blueprint hole.

---

## 3 · Doctrine constraints

| Law                     | Implication                                            |
| ----------------------- | ------------------------------------------------------ |
| No fabricated asset URL | Unconfigured renderer → unavailable data, not fake PNG |
| PII on card             | Zero personal data asserted on share card              |
| No dual-edit            | Path-check open PRs on identity/blueprint              |

---

## 4 · DoD sketch

- [ ] Confirm tracker title string for `blueprint.attestations` on tip
- [ ] If row is stale synonym of shipped work → honesty note / tracker event (mountain event only when owner decides)
- [ ] If real gap: name endpoint + tests + non-goals

---

## 5 · Open questions

1. Is this row still live or should it be retired into card/onboarding notes?
2. Owner call: display name on card (tracker card note).

---

## 6 · Estimated size

| If stale row | **S** docs honesty |
| If new attest product | **M** |

---

## 7 · Related docs / code

- `services/svc-blueprint` card/compose + renderer adapter
- `services/svc-identity` webauthn attestation (different product)
- Long-form twin: [TRK-blueprint.attestations.md](./TRK-blueprint.attestations.md)

---

## 8 · Explicit non-goals

- No inventing card PNG URLs.
- No re-implementing crews/ownership already on main.
- No features.mjs drive-by.

---

## 9 · Collision with identity WebAuthn

| Concern            | Blueprint                       | Identity                          |
| ------------------ | ------------------------------- | --------------------------------- |
| Attestation object | N/A product                     | WebAuthn `attestationObject` CBOR |
| Allowed format     | N/A                             | `none` only                       |
| Share card         | SVG compose · PNG optional rail | N/A                               |

An agent ticket saying “add attestations” must pick **one** plane. Mixing them creates dual product lies.

## 10 · Verification checklist before any PR

- [ ] `rg blueprint.attestations tooling/tracker/features.mjs`
- [ ] `gh pr list` path intersect svc-blueprint / identity
- [ ] Card renderer: unavailable vs URL proof
- [ ] No features.mjs edit from research

## 11 · First PR shape (only if row still live)

| If            | Then                                                    |
| ------------- | ------------------------------------------------------- |
| Stale synonym | Docs honesty + optional tracker mountain event by owner |
| Real gap      | One endpoint + tests + non-goals in this pack updated   |

## 12 · One-line residual

Re-derive tracker; do not invent WebAuthn-in-blueprint or PNG URLs; prefer honesty PR over fake craft.
