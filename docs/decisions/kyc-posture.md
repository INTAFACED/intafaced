# Decision: where KYC applies, and where it does not

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Directed by the repo owner. Recorded so it stops being re-litigated.
**Date:** 2026-07-28 · **Written by:** Denon

---

## The posture

**Zero KYC on the non-custodial surfaces. KYC only where we hold or move someone else's fiat.**

| Surface                              |       KYC       | Why                                                          |
| ------------------------------------ | :-------------: | ------------------------------------------------------------ |
| DEX / perps                          |    **none**     | non-custodial — the user's keys, our matching                |
| Sovereign card (self-custody funded) |   **tiered**    | the user funds it; see the card section                      |
| Protocol plane generally             |    **none**     | §22 — `custodial: false` is already permissionless in config |
| Custodial spot venue                 |    **basic**    | we hold the balance                                          |
| Bank spaces, transfers, earn         |    **basic**    | we hold fiat                                                 |
| Fiat OTC / P2P                       |    **basic**    | fiat rails, counterparty risk                                |
| Merchant payout                      | **basic + MFA** | value leaves the platform                                    |

The organising principle, and the one to apply to anything new: **KYC is the price of us holding your money, not the price of you trading.** A venue that never takes custody has nothing to verify you against.

---

## This is already half-built, which is worth knowing

`packages/config/src/modules.ts` carries a `custodial` flag and a `planes` list. `checkAccess` resolves a `custodial: false` module on the `protocol` plane to `allowed.permissionless` — **no login, no tier, no account gate.** svc-protocol runs on exactly that today.

So the mechanism exists and is tested. What is missing is that the products the owner wants zero-KYC are not on it.

---

## Gap 1 — there is no DEX

`trade` is `planes: ['fiat'], custodial: true`, with `minTier: 'basic'` in `DEFAULT_MODULE_RULES`. That is correct for what it currently is: a **custodial spot venue** that holds user balances in our ledger. It should keep its KYC gate.

The zero-KYC venue is a different product and **does not exist in any form.** It needs one of:

**A. A `dex` module on the protocol plane.** `custodial: false`, settlement against the user's own smart account (`protocol.smart-accounts`, already built). Cleanest separation — the custodial and non-custodial venues never share a code path, so a KYC gate cannot leak into the wrong one, and neither can a bug.

**B. `trade` gains a second plane.** Fewer moving parts, and a permanent hazard: every procedure in svc-trade would need to know which plane it is serving, and the failure mode of getting that wrong is a custodial gate on a permissionless product or, far worse, the reverse.

**Recommendation: A.** The thing that must never happen is a user's funds being custodied on a path they believed was non-custodial. Separate modules make that a deployment error rather than a branch someone forgets.

Not started. `matching.engine` is done and non-custodial already (`custodial: false`), so the book is reusable.

---

## Gap 2 — the card, and the one constraint that is not ours

`bank.cards` is **greenfield**: zero occurrences of `CardIssuer`, `issueCard` or any adapter in the repo. `socket.live-issuer` is already recorded as an external dependency, correctly.

### The constraint

**We do not set the KYC floor on a card. The BIN sponsor does, and their regulator sets theirs.**

A card that spends through the card networks is issued by a licensed institution under scheme rules. Whatever we build, the issuer's compliance programme is the binding constraint — a partner cannot contract out of their AML obligations, and one that offers to is a partner who will be shut down mid-programme, taking the card with them.

So "zero KYC card" is not a thing we can decide unilaterally. That is a fact about the product, not a position on it.

### What such products actually do, and what we should build

They tier it, under simplified due-diligence thresholds that genuinely exist in law:

- **Under a threshold** — no identity verification. Low balance cap, low per-transaction and monthly limits, often no ATM, sometimes domestic-only.
- **Above it** — verification required to raise limits.

That is implementable, it is what the market actually ships, and an issuer will sign it.

### Where the sovereign card fits

`bank.sovereign-card` — _"self-custody funded card, JIT conversion (§18)"_, already on `plane: 'P'` — is the closest thing to the intent. The user funds from their own smart account and we convert just in time, so we never hold their balance.

**That does not remove the issuer's obligation.** JIT conversion changes who custodies the float; it does not change who is issuing a payment instrument into a regulated network. It is still the better architecture for a low-KYC tier, and it is worth building for that reason — just not on the assumption that self-custody makes the card unregulated.

**Action: the tier thresholds are an issuer negotiation, not an engineering decision.** They belong in the `socket.live-issuer` conversation, and they should be a configured parameter, not a constant, because the first issuer will change them and the second will disagree with the first.

---

## What this changes in the code

Nothing yet — deliberately. This records the posture so the work can be scoped. Concretely, when it is:

1. `DEFAULT_MODULE_RULES` gains an entry per new module; a non-custodial one gets `minTier: 'none'`.
2. The tier ceiling on a card becomes a **configured limit**, checked at authorisation, not a constant.
3. `bank.cards` should not be built before the issuer conversation, because the issuer's requirements decide its data model.

## What must not happen

- A custodial surface silently inheriting a permissionless rule. `checkAccess` is the single gate; every new module needs an explicit entry rather than a default.
- A "zero KYC" claim in marketing copy that the issuer's programme does not support. That is the kind of statement regulators read.
- The DEX and the custodial venue sharing an order path. See Gap 1.

---

## Links

- Permissionless mechanism: `packages/config/src/modules.ts`, `packages/config/src/jurisdiction.ts`
- Already permissionless: `services/svc-protocol/README.md`
- Card features: `bank.cards`, `bank.sovereign-card`, `socket.live-issuer` in `tooling/tracker/features.mjs`
