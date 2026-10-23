# trade.otc — durable quote table

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Lane: feat/otc-durable-quotes
Tracker: trade.otc (stays wip — §8 numbers and maker-routing recipe still owner)
Goal: persist open quotes and bound accepts so restart does not drop a promised price
Done-bar: shared store; second OtcDeskService accept/settle finds the same quote; expired still refuses; no invented mid/spread/stake
