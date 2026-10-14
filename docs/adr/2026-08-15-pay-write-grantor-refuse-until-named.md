# ADR addendum: A2 grantor stays owner-named (D26-P0-08)

**Status:** accepted  
**Status note:** **Accepted — 2026-08-15 (mechanism freeze, not A2 content).**  
**Cites (do not rewrite):** [`2026-08-12-pay-write-kyb-grant-mechanism-shape.md`](2026-08-12-pay-write-kyb-grant-mechanism-shape.md) — Layer A/B split and Layer B KYB money gate stay as written.  
**Also on tip:** [`2026-08-13-pay-write-grant-a2-unpublished.md`](2026-08-13-pay-write-grant-a2-unpublished.md) (unpublished → refuse). This addendum corrects the packet: **mechanism only**. A2 answers are still owner.  
**Decision owner (grantor / predicates / revocation):** Nitro (DIRECTION §8 item 4). **Written by:** Denon.  
**Does not invent:** who may grant, role names, dual-control, per-scope KYB thresholds, sandbox temporary grants, or who revokes.

---

## The freeze

> **`issueMerchantPayScopes` stays refuse-closed until the owner names grantor, predicates, and revocation. Approving KYB is not a grant.**

That is the whole A2 freeze. Agents do not fill the four A2 fields in git. Layer B (`kybStatus` on live money doors) is not issuance and is not restated here.

---

## What this does not change

- Shape ADR Layer B (KYB money gate vs dossier vs scopes) — **untouched**.
- `packages/auth` refuse stub — **untouched** this PR.
- Open Denon pay PRs / `services/svc-pay` — **untouched**.
- Ordinary sessions still do not carry `pay:*`.

---

## What remains owner-open

Until Nitro publishes (config / authority store — not a source seed):

1. Who may invoke the grantor.
2. Which KYB predicate applies before each of `pay:read` / `pay:write` / `pay:refund` / `pay:payout`.
3. Sandbox vs live temporary grant (if any; never upgrades live).
4. Who may revoke and whether suspension strips `pay:*`.

Until those four are named by the owner, call sites must surface refuse. Wiring that invokes the named op is allowed; allowing is not.

---

## Packet

`docs/ops/owner-ruling-packet.json` **D26-P0-08** is `mechanism_only` (shape + refuse on tip; A2 content still owner). It is not a full `sealed` owner ruling.
