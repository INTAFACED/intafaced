# ADR: merchant `pay:*` grant A2 — unpublished is refuse (D26-P0-08 close)

**Status:** accepted  
**Status note:** **Accepted — 2026-08-13 (D26-P0-08 sealed).**  
**Amends:** [`2026-08-12-pay-write-kyb-grant-mechanism-shape.md`](2026-08-12-pay-write-kyb-grant-mechanism-shape.md) (mechanism shape already on tip).  
**Decision owner (A2 content):** Nitro. **Written by:** Denon.  
**Does not invent:** grantor role, dual-control, per-scope KYB predicates, sandbox temporary grants, or revoke actors.

---

## The decision (A2)

> **The four A2 answers are unpublished. Unpublished is `auth.merchant_pay_scope_grant_unpublished`. Agents do not name a grantor, do not auto-grant on `kybStatus: approved`, and do not put `pay:*` on ordinary sessions. Layer A stays refuse via `issueMerchantPayScopes`. Layer B (live KYB money gate) is not a grant. Closing P0-08 is this seal, not a crafted grantor.**

This is the same shape as empty dex venues and blank house commission: mechanism exists; content is owner publish.

---

## Why this closes P0-08 without inventing A2

The 2026-08-12 ADR already put shape + refuse stub on tip. The board row stayed open because A2 looked like a leftover engineering question. It is not. Naming `admin:compliance` (or any other actor) in git is DIRECTION §8 item 4 dressed as unblock.

P0-08’s done bar was **shape on tip; mechanism implementable without invent.** Both are true. A2 content remains Nitro.

---

## What is sealed

1. **A1 named op** — `issueMerchantPayScopes` / `assertMerchantPayScopeGrantAllowed` in `@intafaced/auth`. Call sites may only invoke this op.
2. **A2 unpublished → refuse** — residual `DIRECTION §8 item 4`. Code `auth.merchant_pay_scope_grant_unpublished`. `approved` KYB does not grant.
3. **A3 forbidden paths stay forbidden** — no `SESSION_SCOPE_LIST` add, no auto-grant on create/submit/decide, no PayFac tree grant as platform `pay:*`, no API-key mint of ungated `pay:*`.
4. **Layer B is not Layer A** — live `pay.kyb_required` may exist without issuance.

---

## What remains owner-open (Nitro)

The four A2 fields, published on a durable host (not a source seed): who may invoke; per-scope KYB predicate; sandbox temporary grant (if any, never upgrades live); who revokes / whether suspension strips.

Until that publish, merchants cannot authenticate via granted `pay:*`. That is correct.

---

## What agents must not do

- Invent a grantor role or dual-control table.
- Dual-edit `merchant-pay-scope-grant.ts` because this ADR landed.
- Treat P1-P10 wiring as licence to allow.

---

## Proof on tip (already)

- `packages/auth/src/merchant-pay-scope-grant.ts`
- `packages/auth/src/merchant-pay-scope-grant.test.ts`
- Shape ADR `docs/adr/2026-08-12-pay-write-kyb-grant-mechanism-shape.md`
