# ADR addendum: A2 grantor stays owner-named (D26-P0-08)

**Status:** **Accepted — 2026-08-15 (mechanism freeze, not A2 content).**
**Published 2026-10-17:** Nitro named the four answers ("yes grant law"). `issueMerchantPayScopes` now grants `pay:read` and `pay:write` to the owner of one KYB-approved merchant, and refuses everyone else, a second merchant id, refund, payout, and a suspended or closed merchant. This addendum is the record of why issuance stayed refuse-closed until that naming. It is not an instruction to keep refusing.  
**Cites (do not rewrite):** [`2026-08-12-pay-write-kyb-grant-mechanism-shape.md`](2026-08-12-pay-write-kyb-grant-mechanism-shape.md) — Layer A/B split and Layer B KYB money gate stay as written.  
**Also on tip:** [`2026-08-13-pay-write-grant-a2-unpublished.md`](2026-08-13-pay-write-grant-a2-unpublished.md) (the unpublished → refuse seal, kept as history). This addendum corrected the packet to **mechanism only** until the owner named the four answers. Those answers are now the published law in `packages/auth/src/merchant-pay-scope-grant.ts`.  
**Decision owner (grantor / predicates / revocation):** Nitro (DIRECTION §8 item 4). **Written by:** Denon.  
**Does not invent:** who may grant, role names, dual-control, per-scope KYB thresholds, sandbox temporary grants, or who revokes.

---

## The freeze

> **`issueMerchantPayScopes` stays refuse-closed until the owner names grantor, predicates, and revocation. Approving KYB is not a grant.**

That was the A2 freeze. It ended when Nitro named the four answers on 2026-10-17. Approving KYB is still not itself a grant: a call site has to invoke `issueMerchantPayScopes`. Layer B (`kybStatus` on live money doors) is not issuance and is not restated here.

---

## What this does not change

- Shape ADR Layer B (KYB money gate vs dossier vs scopes) — **untouched**.
- `packages/auth` refuse stub — replaced by the published owner law on 2026-10-17. The historical unpublished code is no longer thrown.
- Open Denon pay PRs / `services/svc-pay` — **untouched**.
- Ordinary sessions still do not carry `pay:*`.

---

## The four answers (named 2026-10-17)

1. The merchant owner receives the grant. Admin, finance, developer, and viewer do not.
2. Approved KYB is required for `pay:read` and `pay:write`. `pay:refund` and `pay:payout` stay withheld.
3. There is no sandbox temporary grant.
4. A suspended or closed merchant is refused. Pending is allowed once KYB is approved. The grant names one merchant id.

The product starter fee is still unset. A local-test stand-in is not that number.

---

## Packet

`docs/ops/owner-ruling-packet.json` (removed) **D26-P0-08** is `mechanism_only` (shape + refuse on tip; A2 content still owner). It is not a full `sealed` owner ruling.
