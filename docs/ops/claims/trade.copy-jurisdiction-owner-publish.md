# Claim trade.copy (owner geo publish)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.copy` (stays **wip** — session-key caps protocol)
**branch:** `feat/copy-jurisdiction-owner-publish`
**class:** N

Owner-supplied `TRADE_COPY_JURISDICTION_LAW` (2026-08-14): 49 ISO, not worldwide. Ship in `.env.example`. Compose pass-through with no default. Blank still refuse-closed.

## Leverage

Existing `parseCopyJurisdictionLawJson` + follow screen. No second geo engine.

## Non-goals

- Worldwide / all-ISO
- US/CA/GB/CN/HK/SG/NL/BE or OFAC comprehensive CU/IR/KP/SY
- Minting insurance USDT
- Dual-edit Shehzad chain
