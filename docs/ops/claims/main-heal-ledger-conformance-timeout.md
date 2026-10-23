# main-heal — ledger mixed-run conformance timeout

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Lane: feat/ledger-conformance-timeout
Tracker: none (CI flake, not a product mountain)
Goal: stop PostgresLedger mixed-run replay failing CI at the default 5s under shared runner load
Done-bar: same 50 hold/release posts + reconcile; timeout matches the heavier 200-post sibling (30s, not a weaker assertion)
