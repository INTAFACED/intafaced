# TRK-ops.compliance — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.compliance`  
**Title:** Screening queues, geo-block, VPN/Tor detection  
**Module / phase:** `core-ops` · phase 5 · plane F  
**Status on tip:** ready · **owner:** none (list **content** Class X)  
**Depends on:** `identity.kyc` (done)  
**Requires:** edge/config jurisdiction mechanisms + future ops queues  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Operators process **screening queues** fed by real KYC/risk states — not an empty theatre UI.
2. Platform can **geo-block** and detect **VPN/Tor** per published policy; enforcement **fails closed** when lists/config missing.
3. **Sanctions list content** is Class X (human + counsel) — agents never invent list rows.
4. Commercial region blocks cannot satisfy sanctions boot guards by accident (see screening-config honesty PRs).
5. No partner vendor names in user-facing block reasons beyond allowed product language.

---

## 2 · Current code state (tip)

### 2.1 Mechanism fragments exist; programme does not

| Fact                      | Tip                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| identity.kyc + kyc-review | **done** — submit/approve/reject/queue APIs                                                               |
| Jurisdiction / region     | packages/config + apps/admin jurisdiction page; edge access checks                                        |
| Screening config honesty  | Open/merged Denon-adjacent PRs historically (e.g. #432 screening-config) — **re-derive** before dual-edit |
| VPN/Tor detection product | **Not** a complete monorepo programme                                                                     |
| Sanctions content         | **Class X** — not agent-authored                                                                          |
| Full ops compliance desk  | **Not built** as svc-core-ops                                                                             |

### 2.2 Dual-edit risk

Do not edit open Denon config/screening files mid-wave for “queue UI.”

---

## 3 · Doctrine constraints

| Law          | Implication                                          |
| ------------ | ---------------------------------------------------- |
| § compliance | Geo KYC/AML, geo-block, VPN/Tor, jurisdiction matrix |
| Class X      | Sanctions **content** + legal posture                |
| Fail closed  | Missing lists → refuse risky paths                   |
| Brand        | No raw vendor names in user copy                     |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — mechanism honesty

- [ ] Boot guards + region vs sanctions authority clear on tip
- [ ] Document fail-closed matrix

### Stage 2 — operator queue

- [ ] Queue schema reading identity KYC states
- [ ] Empty queue honest when none pending

### Stage 3 — VPN/Tor signals

- [ ] Adapter interface + provider config (Class X credentials)
- [ ] Edge enforcement hooks

**Tracker `done`:** queues + geo enforcement + VPN/Tor mechanism with **content** owned by humans — agents cannot finish content half.

---

## 5 · Open questions

1. VPN provider choice — Class X procurement?
2. Appeal path for false positives?
3. Which products hard-block vs warn?

---

## 6 · Estimated size

| Slice                     | Size    | Notes                 |
| ------------------------- | ------- | --------------------- |
| Queue API over KYC states | **S–M** | After config PRs land |
| Edge VPN hooks            | **M**   | + Class X secrets     |
| Full programme            | **L**   |                       |

**First implement PR:** **S** empty-honest screening queue API over KYC — **no** list invent.

**Human blockers:** Class X; Product; Dual-edit.

---

## 7 · Related docs / code

- identity.kyc / kyc-review
- packages/config jurisdiction
- Denon screening-config PRs — re-derive
- Class X ownership law

---

## 8 · Explicit non-goals for this pack

- No agent-authored sanctions lists.
- No dual-edit open screening PRs.
- No vendor names in user copy.
- No features.mjs done.
