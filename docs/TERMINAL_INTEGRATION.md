# DECISION RECORD — FinceptTerminal evaluated and rejected

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** July 2026 · **Status:** closed · **Outcome:** build our own

---

## Decision

INTAFACED builds its own pro terminal. FinceptTerminal is not vendored, forked, licensed, or shipped.

It remains useful as a **reference for scope** — see §3 — and nothing more. No code, no binaries, no assets.

The live architecture is [`TERMINAL.md`](TERMINAL.md).

---

## Why it was rejected

**1 · Licensing.** AGPL-3.0 with a dual commercial licence at **USD 10,200/year**, mandatory for business use, SaaS/hosted/white-label, and financial firms. The terms explicitly name _"forks that replace Fincept's APIs, even if rebranded"_ — precisely what an integration would have been. Under plain AGPL, network use obliges publishing source to users, which cannot coexist with a confidential commercial exchange. Stated liquidated damages reach USD 250,000+ per violation, retroactive fees at 18% interest, Indian law and Delhi courts.

Buying the licence was a real option. It was rejected on the second ground.

**2 · Architecture.** Qt6/C++20 native desktop with 1,034 `.cpp`, 969 `.h`, and 1,379 `.py` files driving Python analytics as subprocesses. That is a second platform with its own toolchain, its own build, and its own release process — breaking Doctrine §0.5 (_"One language. TypeScript everywhere. Agents never context-switch."_) and §1 (_"Next.js 15 — all user surfaces, one design system"_).

An annual licence fee for a codebase our agents cannot work in, that fragments the design system, is a worse deal than building it.

**3 · Direction of flow.** It is a _research_ terminal built around external data connectors and external broker integrations. We are the broker. Its centre of gravity points outward; ours points at our own book.

---

## What was kept

The audit was not wasted. Three things came out of it and are now in the build:

| Finding                                                                                 | Where it landed                                                                                                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Their trading layer runs entirely on **CCXT** — the de-facto unified exchange interface | `packages/exchange-contract` — we _serve_ a CCXT-compatible API, so every bot and third-party terminal can trade on us |
| CCXT is equally the standard for _consuming_ venues, and is MIT-licensed                | `packages/venue-adapter` — cross-venue liquidity aggregation                                                           |
| A pro terminal's realistic scope is ~57 screens, far beyond a trading panel             | Scope reference for `TERMINAL.md` §3                                                                                   |

---

## Guard

`Fincept` is in the `brand-scan` forbidden list (`tooling/ci/brand-scan.mjs`) and stays there. We ship none of their code and none of their naming; CI enforces it rather than trusting anyone to remember.

This file is allowlisted so the decision remains readable.
