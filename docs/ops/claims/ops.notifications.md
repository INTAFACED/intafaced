# Claim ops.notifications

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**owner:** nitro-agent
**slice:** operator delivery outcomes view
**branch:** feat/notify-delivery-outcomes
**pr:** https://github.com/Phantom-X-007/intafaced/pull/2221
**updated:** 2026-08-16

Tracker residual: operator delivery outcomes (`notify.ops.deliveries`, `admin:read`). Durable rows from `notify.deliveries` — in-app may be `accepted`; OOA without gateway stays `refused` / `channel.not_configured`. No digest wiring. No Class X credentials.

This file is a **slice** lock. Do not set `merged` here — a non-`TRK-` spent lock would hide the mountain while §13 OOA sockets remain owner Class X.
