# ADR: `pay:write` / KYB grant mechanism shape (D26-P0-08)

**Status:** **Accepted as mechanism shape — 2026-08-12.** Grant **issuance** itself remains owner-sealed (DIRECTION §8 item 4). This ADR does **not** invent who grants or auto-approve KYB.
**Decision owner (issuance):** Nitro (DIRECTION §8.4 / §8 item 4).
**Shape owner (this document):** Denon.
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed) **D26-P0-08** (shape) → **D26-P1-P10** (implement after seal).
**Law cited:** `DIRECTION-2026-07-31.md` (removed) §3 item 2 · §8 item 4; harvest `PAY-LANE-HARVEST-AND-BUILD-PLAN-2026-08-08.md` (removed) §1.1.
**A2 grantor freeze (pointer, 2026-08-15):** [`2026-08-15-pay-write-grantor-refuse-until-named.md`](2026-08-15-pay-write-grantor-refuse-until-named.md) — `issueMerchantPayScopes` stays refuse-closed until the owner names grantor, predicates, and revocation; no auto-grant on KYB approved. **Layer B below is not rewritten.**

---

## The decision (shape only)

> **Merchant `pay:*` scopes stay withheld from ordinary sessions. The grant path is a named, refuse-closed mechanism until the owner publishes grant law. KYB dossier transitions are not grants. Money gates that read `kybStatus` are not grants. Agents must not invent either.**

Done bar for **D26-P0-08:** this shape is on tip and a refuse stub exists so D26-P1-P10 can wire without inventing issuer, threshold, or auto-grant.

---

## Why this is two layers (not one flag)

Today the merchant surface fails twice, for different reasons:

| Layer                  | What it controls                                                                                                  | Tip truth                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Scope issuance** | Whether any principal may call merchant tRPC/REST at all (`pay:read` / `pay:write` / `pay:refund` / `pay:payout`) | All four are in `WITHHELD_FROM_SESSION` (`packages/auth`). Justification says “granted by merchant onboarding.” **Nothing grants them.**    |
| **B — KYB money gate** | Whether an already-authorised merchant may move acquiring value                                                   | `kybStatus` moves via dossier stubs; money paths gate on `merchants.status`, **not** `kybStatus` (`w6-honesty-residuals` pins the absence). |

Collapsing A into B (e.g. “flip `kybStatus` to approved ⇒ invent `pay:write` on the session”) is how an invented grant becomes policy. Collapsing B into A (scopes without a KYB money check) is how a rejected merchant still clears after somehow holding scopes.

**Shape rule:** A and B are both required for production acquiring. They are implemented as separate checks. Neither check invents the other’s outcome.

---

## Mechanism shape (implementable without invent)

### A1 · Named grant operation

A single operation owns issuance of merchant acquiring scopes:

```text
issueMerchantPayScopes(request) → { scopes } | refuse
```

- Lives next to auth scope law (`@intafaced/auth`), not inside payment create/capture.
- Callers (future `svc-identity` / ops desk / onboarding worker) may **only** call this operation — they do not append `pay:*` onto session tokens ad hoc.
- Default posture: **refuse-closed** with a stable residual string until owner law is published (see stub `assertMerchantPayScopeGrantAllowed`).

### A2 · What the owner must seal (not agent-fillable)

Publish (config / authority store — not a source seed) answers to:

1. **Who may invoke the grantor** — e.g. `admin:compliance` only, dual-control, or a named onboarding role.
2. **After what KYB predicate** — which `kybStatus` (and any tier) is required before each of `pay:read` / `pay:write` / `pay:refund` / `pay:payout`.
3. **Sandbox vs live** — whether any temporary grant exists under allow-sandbox, and that it never upgrades posture.
4. **Revocation** — who may strip `pay:*` and whether suspension implies revoke.

Until those four are sealed, the grant operation **refuses** and names `DIRECTION §8 item 4`. That is honest; inventing a grantor is not.

### A3 · Forbidden invent paths (explicit)

Agents must not:

- Add `pay:*` to `SESSION_SCOPE_LIST`.
- Auto-grant on `merchant.create`, `submitKyb`, or `decideKybStub`.
- Treat sub-merchant area grants (`submerchantPermission.grant`) as platform `pay:*` issuance — those are tree permissions under an already-scoped merchant parent.
- Mint API keys bearing `pay:*` for principals that never received a grant (delegation cannot create authority — `assertDelegatableScopes`).

### B1 · KYB money gate

After scopes exist, money procedures that call `assertMerchantActive` also require approved KYB under `live-only` (`pay.kyb_required` via `merchantKybMoneyGateRefusal`). Sandbox (`allow-sandbox`) stays status-only so fixtures do not invent a grantor.

Open PSP/KYB product PRs may own dossier history and PSP mode; Layer B only **reads** `kybStatus` on money doors and does not dual-edit those writers. Approving KYB never issues `pay:*` (Layer A).

---

## Refuse stub on tip

`packages/auth` exports:

- `MERCHANT_PAY_SCOPE_GRANT_RESIDUAL` — stable owner residual copy.
- `MERCHANT_PAY_SCOPES` — the four acquiring scopes.
- `assertMerchantPayScopeGrantAllowed(...)` — always refuses until owner law is published (no silent allow, no invented grantor).

D26-P1-P10 replaces the refuse body with a reader of published grant law — without changing the call sites’ contract.

---

## Path fences (this ship)

Open parallel pay work owns colliding trees. This shape PR deliberately avoids:

- `#1718` routing (`services/svc-pay/src/routing/*`, `router.ts` money-door edits)
- `#1720` PSP / KYB product (`kyb-*`, `psp-mode*`, `db/merchant-kyb*`, pay `index.ts`, `features.mjs`)
- `#1724` plugins (`services/svc-pay/src/plugins/*`)
- `fraud/*`

---

## Done bar

### D26-P0-08 (this ADR)

1. Shape written and Accepted as mechanism.
2. Refuse stub exists and is tested — grant attempts fail closed with the residual.
3. No invented grantor, threshold, or session issuance.

### D26-P1-P10 (wiring — no invent grants)

1. ~~KYB money gate on live money doors~~ — wired (`pay.kyb_required` under `live-only`).
2. Named issuance op + svc-pay call site — `issueMerchantPayScopes` / `issueMerchantPayScopesViaGrantPath` still refuse until A2.
3. **Still owner-sealed:** published grant law body (who grants + per-scope KYB predicate + sandbox grant + revoke).

---

## What agents may implement without asking again

- Call-site wiring that **invokes** `assertMerchantPayScopeGrantAllowed` / `issueMerchantPayScopes` and surfaces the refuse.
- Tests that pin “no session `pay:*`” and “grant refuses when law unpublished.”
- Layer B KYB **money-gate** on live doors that **reads** `kybStatus` without inventing scopes.

## What still needs the owner

- Every answer in **A2** (issuance still refuse-closed until then).
- Any production claim that merchants can authenticate via granted `pay:*`.
- Class X acquirer / go-live posture (unchanged).
