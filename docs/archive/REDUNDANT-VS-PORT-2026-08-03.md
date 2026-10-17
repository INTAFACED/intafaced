# Redundant vs port — old work vs vendored exchange kit shell

**Type:** Chat B outcome · decision list for Nitro  
**Verified:** `origin/main` @ `d768d7c` (2026-08-03)  
**Inputs:** shell inventory + `apps/web` tree + commit themes since Stream A  
**Product rule:** shell = product · `apps/web` retired as product

---

## Verdict (one breath)

| Pile     | Meaning                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **KEEP** | Almost all Stream A / craft work **already on the Vue shell** — not wasted; keep improving there.                                |
| **PORT** | A **short list of patterns** from `apps/web` (how it talks to our live edge/WS) — re-express in the shell, not copy React files. |
| **DROP** | Treating `apps/web` as a second product; more Next terminal features; dual design systems.                                       |

**Bottom line:** You did **not** build a huge throwaway product. The big pile is **already on vendored exchange kit**. The small Next app has a few **live-wiring lessons** worth stealing, then ignore as product.

---

## 1 · KEEP (already on shell — do not redo / do not trash)

These landed under `vendor/exchange-tree/05_Web_Front` (and related tooling). **This is your main work product.**

| Theme                                    | Evidence (examples)                                                                            | Why keep                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| **Honesty / empty ≠ error**              | Depth, market list, UC money panes, OTC, CMS, activity, envelope, AFK invite/activity/envelope | Trust floor on real screens    |
| **Account / withdraw / safe desk craft** | Waves A/B, withdraw net+receipt, fee disclosure, mobile sticky                                 | Trader desk quality            |
| **Order entry polish**                   | Validation + honest confirm                                                                    | Money-adjacent UX              |
| **Dual-book / plane honesty**            | Account banners, CEX/DEX plane in `App.vue`                                                    | Product law visible in UI      |
| **Desk tools**                           | Hotkeys, blotter tools, panel resize, watchlist density, CMDK, a11y/focus                      | Pro-trader bar                 |
| **Auth / login honesty**                 | Login a11y, AboutUs, partner honesty                                                           | Onboarding trust               |
| **intafaced overlays**                   | Academy, Bank, Dex, Pay, Protocol, Chain, … + `NotBuilt`                                       | Our modules inside shell       |
| **Brand / tokens on shell**              | `intafaced.css`, rebrand wave                                                                  | Our look on product surface    |
| **Proof harness**                        | `tooling/uiproof/*`, residual register                                                         | Prevents “green but lying”     |
| **Shell deploy**                         | Dockerfile, nginx, :8090 (Denon)                                                               | Makes all of the above visible |

**Do not** rebuild these in Next. **Do** keep fixing/extending them on the shell.

---

## 2 · PORT (from `apps/web` → shell as _behavior_, not file copy)

`apps/web` is small (~58 tracked files under the app): landing + **one** `/trade` terminal wired to **our** TypeScript services. Shell already has chart/depth/exchange UI (including lightweight-charts + `DepthGraph.vue` + huge `Exchange.vue`). What Next still teaches is **how we wire to _our_ bus**.

| #      | What                                                                         | Where it lives today                               | Port means                                                                                | Priority                                        |
| ------ | ---------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **P1** | **Public trade tape** over `svc-ws` `channel=trades` (empty ≠ broken)        | `live-tape.tsx`, `trade-transport.ts` (+ tests)    | Same honesty on shell trade panel / exchange trades list                                  | **High** if shell still Java-tape or quiet-fail |
| **P2** | **Depth stream controller** (snapshot + sequenced deltas, gap handling)      | `depth-controller.ts`, `ws-transport.ts` (+ tests) | Align shell book with `svc-ws` semantics Denon built                                      | **High** for live desk                          |
| **P3** | **Edge client habits** (typed REST to edge, no invent on failure)            | `edge-client.ts`, `rest.ts`, `result.ts`           | Vue API layer talks to **edge only**, same failure rules                                  | **High** (pairs rewire)                         |
| **P4** | **Money as decimal strings** helper discipline                               | `money.ts` (+ tests)                               | Any display/input path on shell uses same rules (no float paint)                          | **Medium**                                      |
| **P5** | **Plane copy from registry** (custody sentence from `MODULES`, not freehand) | `plane.ts` + plane-switch                          | Shell plane switch already exists; tighten copy/source so UI can’t drift from custody law | **Medium**                                      |
| **P6** | **Account equity from live services** (honest empty)                         | `account-equity.tsx`                               | Shell balances panes already craft’d; ensure **source** is our edge/ledger not dead Java  | **Medium** (rewire)                             |
| **P7** | **Order ticket “can’t fetch → don’t draw fake”**                             | `order-ticket.tsx`, terminal comments              | Mirror rule on shell order entry                                                          | **Medium**                                      |
| **P8** | **Blotter = mine vs tape = public** separation                               | blotter vs live-tape comments                      | Keep that product distinction clear on shell                                              | **Low** if already clear                        |
| **P9** | **fabricated-money test helpers**                                            | `testing/fabricated-money.ts`                      | Reuse idea in shell/ui tests so invent can’t regress                                      | **Low**                                         |

**Not a port (wrong shape):**

- Copying React/Next components into Vue.
- Moving `packages/ui` into the Vue app as the only design system (shell has its own CSS tokens).
- Replacing shell `Exchange.vue` wholesale with the Next terminal layout unless you later choose a deliberate redesign.

**Denon preference:** charts → **TradingView** long-term; shell already has lightweight-charts — port chart _data honesty_, not a third chart stack this week.

---

## 3 · DROP (stop spending here)

| Item                                                                                    | Why drop                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **`apps/web` as product / default demo**                                                | Shell is product; dual surface caused the drift story         |
| **New features only on Next terminal**                                                  | Diverges forever                                              |
| **Rebuilding auth, OTC, CMS, activity in Next**                                         | Shell already has full areas                                  |
| **Parallel “sexy redesign” of whole exchange in Next**                                  | Explicitly not the path                                       |
| **Marketing invent money on landing**                                                   | Already fixed once (#416); don’t reintroduce in either app    |
| **Treating Stream A shell commits as “redundant because vendored exchange kit exists”** | Those commits **are** the vendored exchange kit product layer |

**Repo fate of `apps/web` (recommended):**  
leave code on main for now (tests, edge examples) · **no product roadmap** · optional later delete or demote to internal sandbox. No decision needed beyond “not product.”

---

## 4 · Split that reduces anxiety

| Workstream                                                        | Redundant?                                      | Action                    |
| ----------------------------------------------------------------- | ----------------------------------------------- | ------------------------- |
| ~49 commits of shell craft/honesty                                | **No**                                          | KEEP + continue           |
| Next terminal live WS/edge wiring                                 | **Partially**                                   | PORT patterns P1–P3 first |
| Next as second home for traders                                   | **Yes**                                         | DROP product role         |
| Scaffolding vendored exchange kit already had (login, many pages) | You didn’t invent those; you **civilized** them | KEEP civilization         |

---

## 5 · Suggested order (after this doc)

1. **No more Next product work.**
2. On shell FE board, pick **P1–P3** only when a screen is being rewired to edge/WS anyway (don’t boil ocean).
3. Rest of FE board = craft/rewire/honesty on **existing** shell pages (Chat D).
4. Landscape (Chat C): still optional; only if P-charts need TradingView path.

---

## 6 · Agent one-liner

```
KEEP shell craft. PORT apps/web live edge/WS honesty patterns into Vue when rewiring.
DROP apps/web as product. Do not rebuild shell features in Next.
```

---

_Re-check open rewire PRs before duplicating Denon’s #418 territory._
