# Claim TRK-trade.otc

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** merged
**proof:** #1000 merged 2026-08-07 — OTC RFQ Stage refuse-closed blank DIRECTION §8 law
**owner:** cursor-swarm-otc
**class:** M
**scope:** D-S-02 / SPEC-OTC-RFQ-AND-EARN Part A Stage — RFQ disclosures, no last look, refuse blank DIRECTION §8 desk law; ledger-client settle when published
**branch:** feat/trade-otc-stage
**updated:** 2026-08-07 (claim closed against merged main)

## Non-goals

- Invent spread bps / min stake / principal choice (DIRECTION §8)
- Touch `futures/**` or `algo/**`
- Maker-routed settle recipe (refuse until owner publishes)

## Shipping

Refuse-closed default; quote/accept/settle wired on svc-trade `otc.*`; tests prove blank law refuse + bound fill + ledger posts.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
