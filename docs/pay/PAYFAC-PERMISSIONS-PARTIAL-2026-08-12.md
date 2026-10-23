# PayFac permissions — honest partial (D26-P1-P2)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker:** `pay.payfac`  
**Board:** D26-P1-P2 — sub-merchant permissions real or honest partial + §13  
**Leverage:** in-repo `svc-pay` trees (`submerchants.ts`) + `assertMerchantAreaAccess` — extend, do not rebuild.

## What is real on this path

- Eleven permission areas (not fourteen — title string is historical; owner decides whether to rename).
- Structural subtree fence + area journal (`pay.merchant_permission_events`, append-only).
- Gateway money paths and public REST call `assertMerchantAreaAccess` with matching areas.
- tRPC `submerchantPermission.*` delegates grants/revokes with principal-resolved actor (never `actorMerchantId` on the wire).
- **This ship:** REST permission surface (`/v1/submerchant-permissions/*`) + shared map in `payfac-permissions.ts`, so facilitators can grant/list without the monorepo tRPC client.

## Honest §13 / owner residuals (not inventable here)

| Socket id                              | Why code stops                                                        |
| -------------------------------------- | --------------------------------------------------------------------- |
| `socket.payfac-settling-party-partner` | Non-`self` settling party = acquiring; see `socket.psp-partners`      |
| `socket.payfac-split-fee-recipes`      | Platform vs sub-merchant fee splits need DIRECTION §8 owner fee table |

Default onboarding grants remain **visibility only** (`merchant.profile`, `submerchant`). Money areas require an explicit grant + reason.

## Collision fence

Open pay PRs #1718 (routing), #1720 (PSP/KYB), #1724 (plugins) own `router.ts` / `index.ts` / plugins / tracker tip files. This path stays in `payfac-permissions.*` + `public-rest.ts` (+ this note).
