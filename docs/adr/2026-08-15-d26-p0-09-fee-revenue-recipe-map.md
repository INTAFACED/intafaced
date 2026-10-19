# ADR: Fee + revenue recipe map — closed matrix, no invent (D26-P0-09)

**Status:** **Accepted — 2026-08-15 (D26-P0-09 law seal).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-09 — fee + revenue recipe map.  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-09.  
**Index:** `docs/ops/owner-ruling-packet.json` (removed) `D26-P0-09`.  
**Does not invent:** a new ledger recipe, a fee magnitude, a compose default for `TRADE_FUTURES_PROFIT_SOURCE`, or a second money book.

---

## The decision (one sentence)

> **Every fee and revenue path is already a named `packages/ledger-client` recipe or an explicit §13 socket. The live inventory is the closed matrix. Agents do not add recipes. A missing path is a socket or an owner carve-out — never a silent new function.**

This is the **law seal**. Code inventory already landed as **D26-P2-11 #1745** (`src/recipes/live-path-inventory.ts` + `RECIPES.md`). This ADR does not duplicate that table and does not edit `packages/ledger-client`.

---

## What is sealed

1. **Authority of the matrix.** `export const recipes` plus `RECIPE_MATRIX` in `packages/ledger-client/src/recipes/live-path-inventory.ts` (executed by `live-path-inventory.test.ts`). Human table: `packages/ledger-client/RECIPES.md`. If they disagree, the registry wins.

2. **Closure rule.** Every registry key is `live` (a production caller posts it) or `socket` (§13 — recipe exists so the path can be honest later; nothing wires it today). That is the P2-11 done bar. P0-09 adds the **product-law** bar: a fee/revenue _path_ that is not on that matrix is not “needs a new recipe.”

3. **No new recipes without owner carve-out.** Adding `recipes.<name>` is inventing money shape (DIRECTION §8 item 6). Allowed only after this packet row is explicitly re-opened with an owner note naming the path, the module, and why no existing recipe or §13 socket suffices. Review rejects:

   - a new recipe function “because a fee path needs one”
   - inline `entries:` assembled in a service
   - a second fee book outside `ledger-client`
   - classifying a path as `live` by inventing a caller

4. **How a missing path is refused.** Name the residual and stop:

   | Situation                                 | Refuse                                                                              |
   | ----------------------------------------- | ----------------------------------------------------------------------------------- |
   | Fee/revenue movement with no named recipe | Do not ship. Open or extend a **§13 socket**; do not add a registry key.            |
   | Recipe exists, unwired                    | Keep `kind: 'socket'` in the live inventory. Do not invent a writer.                |
   | Recipe exists, live                       | Call `ledger.post(recipes.<name>(…))` only. Magnitudes still owner (P0-02 / P0-10). |
   | Want a _new_ recipe anyway                | Owner carve-out on `D26-P0-09` first. No carve-out in this ADR.                     |

5. **`TRADE_FUTURES_PROFIT_SOURCE` still has no default (PKT-B5).** `futuresRealizeProfit` is a **named live recipe**. Compose still passes `${TRADE_FUTURES_PROFIT_SOURCE:-}`. Empty host → futures profit refused. This seal does **not** invent a compose default, does not change PKT-B5, and does not treat `.env.example` as a runtime default.

---

## What already exists (pointer, not a second inventory)

Do not copy the 55-row table here — it will rot. Point:

| Surface                                                  | Where                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Registry + human matrix                                  | `packages/ledger-client/RECIPES.md`                                                                         |
| Live vs §13 (P2-11 #1745)                                | `packages/ledger-client/src/recipes/live-path-inventory.ts`                                                 |
| House-fee-touching path ids (P0-09 code inventory #1732) | `packages/ledger-client/src/recipes/fee-revenue-map.ts` — **do not dual-edit**; law does not add rows there |

Fee collection already rides existing recipes (`tradeFill` / `marketMakerMakerFill` maker-taker → `houseFees(trade)`; `escrowRelease` `feeBps` → `houseFees(p2p)`; `merchantSettlement` fee → `houseFees(pay)`; `feeCharge`; `marketPurchase` commission; listing/premium §13; loan/earn house legs). Revenue draw already rides `sweepFeesToRewards`, `rewardPay`, `futuresRealizeProfit`, `futuresInsuranceTopup` (§13 writer). Chargebacks stay §13 unwired (pay.rails).

---

## What this does not close

- **P0-02** rate / fee-share numbers.
- **P0-10** commission _magnitude_ (mechanism already sealed).
- **PKT-B5** naming a host default for the futures profit pot — still no compose default.
- **D26-P2-11** inventory maintenance — that package stays one-writer; this PR does not touch it.

---

## What agents must not do

- Edit `packages/ledger-client` to “complete” this seal.
- Dual-edit P2-11 `live-path-inventory.ts` or P0-09 `fee-revenue-map.ts`.
- Add `${TRADE_FUTURES_PROFIT_SOURCE:-house:…}` in compose.
- Treat #1732 or this ADR as permission to invent a recipe.

---

## Leverage

Phase A: existing `ledger-client` recipes + live-path inventory (#1745). Wire callers; do not rebuild a fee book or a second SPA.

---

## Done bar

1. This ADR Accepted as law.
2. Packet `D26-P0-09` points here; PART-TWO §P0-09 is a pointer, not a second matrix.
3. New recipes refused without owner carve-out (table above).
4. `TRADE_FUTURES_PROFIT_SOURCE` still has no compose default.
5. No `packages/ledger-client` delta in this ship.
