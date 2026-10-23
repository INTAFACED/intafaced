# D26-P1-O2 — pay affiliate accrue caller

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Lane:** `denon-d26-p1-o2-pay-accrue`  
**Tracker:** `ops.affiliates`  
**Goal:** After `merchantSettlement` posts house pay fees, best-effort identity accrue (`sourceModule: pay`).  
**Done-bar:** 412/down never unwind settlement; zero fees skipped; compose `IDENTITY_URL` pass-through; no invent rates.

Do not: dual-edit svc-identity / svc-trade · invent PSP · Vue.
