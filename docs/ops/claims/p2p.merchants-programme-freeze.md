# Claim p2p.merchants (operator freeze)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `p2p.merchants` (stays **done** on features.mjs — this slice does not flip the mountain; badges+limits+API residual remains)
**branch:** `feat/p2p-merchant-programme-freeze`
**class:** N (honesty) / M surface (no invented escrow recipes)

Operator freeze/revoke is `suspended` against the same reputation snapshot badges use. Frozen standing cannot use raised programme privileges. Unfreeze re-checks live eligibility; derived badges are not minted. Public doors: `GET /internal/reputation/:userId` + `reputation.get` + `merchants.decide`.

## Found on tip

Freeze already existed as programme `suspended`. The lying door was `GET /internal/reputation/:userId`: it served derived badges with no `merchant` vouch, so a frozen merchant still looked vouched-for to S2S readers. Unfreeze could restore `approved` without re-running apply eligibility.

## Leverage

Phase A IN: existing `svc-p2p` reputation + programme standing. Horizon `p2p.merchants` = IN (OPEN_MONEY). No new ledger recipes. No second scorecard table.

## Non-goals

- Invent escrow recipes
- Mint `p2p:moderate` / Class X moderator id lists
- Flip tracker done/ready
- Vue / svc-trade / Shehzad chain
- Invent fee magnitudes
