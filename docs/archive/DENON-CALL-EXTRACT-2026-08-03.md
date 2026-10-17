# Denon call extract — what matters now

**Source:** voice call “Nitro fucked up??? no way” · 2026-08-03 · Nitro + Denon  
**Purpose:** forward alignment only. Noise (beard, couch, PEPE, sub tiers) dropped.  
**Claim tags:** `[FROM CALL]` · prior git facts not re-argued here.

---

## Final product state (aligned)

| Topic                            | Decision                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What is the product app?**     | **vendored exchange kit / vendored vendored exchange** = core app + core UI. Path: `vendor/exchange-tree` (web front, web admin, engines, wallet RPC, Android/iOS, docs).                                       |
| **How we build**                 | **Enhance and integrate on top** — not throw away and rewrite from zero. Routes, providers, our features plugged in. UI fully editable (not a black box).                                                       |
| **Money**                        | Denon (call): keep fitting into that stack; earlier ADR still = **our ledger is the only book**. Call is product spine; ADR is money law — both stand.                                                          |
| **Not in vendored exchange kit** | Own **L1 / chain ecosystem** — not covered by the exchange kit.                                                                                                                                                 |
| **Second web app (`apps/web`)**  | Call never re-opened three options. Direction = one core UI (vendored exchange kit). **Treat `apps/web` as non-product** (retire as product). Optional salvage later only if something unique is worth copying. |
| **Casino**                       | Denon: **done for what we need**; only games-provider API left. Nitro does not need to own it now.                                                                                                              |
| **V1 vs later**                  | Ship **good V1** of the real exchange first. G-master / ancient intelligence / spiritual onboarding / custom widget OS = **future chapter**, not current sprint.                                                |

---

## Who owns what (from this call)

| Person              | Ownership now                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nitro**           | **Frontend** — explicit end of call: “leave front end to me.” Build own **task board** and hammer. Agents get context from **repo + law docs**.                                                                                                                                                                      |
| **Denon**           | Took “everything” yesterday to **unstick/fix drift** (shell runnable, pages visible). Not a permanent “Nitro out of UI.” He is free to **move on Intafaced** broadly; coordinate so paths don’t double.                                                                                                              |
| **Shehzad (Shiso)** | Self-claimed today (Telegram): **perps** (cross/isolated), **margin, funding, liquidation ladder**, **branded gateway, hosted checkout, payment links**. Prefer **text** over voice. Nitro may **narrow/finish** his board so work isn’t wasted, then lean **blockchain / DEX / L1 integration** with Denon enhance. |

---

## Spec / planning rules Denon stated

1. **Canon:** `INTAFACED SOVEREIGN OS` PDF + `INTAFACED_DEFINITIVE_BUILD.md` (may miss a few post-vendored exchange kit adds — refresh against repo).
2. **Don’t mega-plan day one.** Spec phase → plan only **phases 1–3** → execute green → then plan 4–6 from reality.
3. **Charts:** prefer **TradingView** integration over home-grown charts.
4. Freshness: **GitHub/repo is the vendored exchange kit source of truth** for what’s in tree; landscape/internet leverage optional, not blocking start.

---

## What happened to your UI work (call)

- Last night Denon **unlocked** the shell so **your pages can finally render** (they weren’t visible when not deployable).
- He **accidentally deleted some color work** (you: turquoise, not blue) — check git / re-apply if needed.
- Your sense that some **wiring** is less needed because vendored exchange kit already has auth/2FA/screens is partly true for _scaffolding_; **honesty/craft on the shell still counts**.

---

## Parallel business (not agent code, but call commitments)

- **English lads / volume / fees:** warm path still open; Kane tour soon.
- **PSP:** Patrick track this week + optional Nitro cold outreach (requirements → offer → then call). Don’t wait forever on English-only. Direct PSP can skip middlemen if they can fulfill.
- Casino / coach / personal: out of engineering board.

---

## Explicit next moves they agreed

1. Nitro: transcript → agent → **one alignment page** (this doc); Denon can add bits.
2. Nitro: **own FE task board**, orient agents on `vendor/exchange-tree`, hammer V1 shell.
3. Nitro: **Shehzad passport** — what’s open, finish current push, proposed scope (blockchain lean); Denon enhances.
4. Denon: **move** on platform; respect FE as Nitro’s.
5. Both: **don’t** open spiritual/AI GTM as current build priority.

---

## Agent instructions (compressed)

- Product UI = vendored shell (`05_Web_Front` etc.), not `apps/web` as product.
- Do not implement Shehzad’s claimed pay/perps paths unless he frees them.
- Prefer TradingView for pro charts.
- Near-horizon plans only (1–3).
- Canon docs + live repo; re-fetch main before coding.
