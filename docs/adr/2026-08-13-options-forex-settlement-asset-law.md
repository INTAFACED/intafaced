# ADR: options / forex settlement asset law

**Status:** **Accepted freeze — 2026-08-15 (D26-P0-05 sealed).** Shape from 2026-08-13 still binds. This freeze **names** the live set and the settlement asset as empty/unset so engines cannot invent a catalogue.
**Decision owner:** repo owner (Denon). **Written by:** Denon.
**Board:** D26-P0-05 — Options / forex settlement asset law.
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-05.
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §2 (instrument model; forex/commodities do not production-list until fiat rails exist) and §8 item 5 (agents do not decide the catalogue); [`2026-08-12-listing-delisting-policy.md`](2026-08-12-listing-delisting-policy.md) (D26-P0-06); D-S-06 one matching book; D26-P1-T6 refuse-close already on tip.
**Does not invent:** option underlyings, FX pairs, a cash payoff coin, D7 fixing source/window/payor, fee bps, or a euro-stablecoin standing in for fiat.

---

## The decision

> **(1) Live instrument set — empty.** No options chain and no settleable forex/commodity production set is published. Modelled or seeded rows are not this set. Until a later **owner stamp** names instruments, the live set is the empty set.
>
> **(2) Settlement asset — unset.** There is no owner-named ledger asset for options cash payoff or for FX PnL. Agents do not write USDT, USDC, USD, IFC, or “use the quote asset” into source, env defaults, or compose to close a tracker row.
>
> **(3) Refuse matrix — named codes, never a parsed list.** Empty/unset is a named refuse. `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` stays empty under this freeze. If it is later non-empty, it is an **opaque** operator id — never parsed for assets, pairs, or matrix rows.

This is settled. Agents implement against it. They do not re-litigate the live set.

---

## Why the 2026-08-13 shape was not enough

`trade.options` and `trade.forex` have been `ready` long enough that a craft PR could “finish” them by inventing a settlement asset. DIRECTION §8 item 5 forbids that.

The 2026-08-13 seal wrote the refuse names and the European/full-collateral **shape**, then left the live set and the settlement asset “owner-open” and treated `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` as “this ADR is in force.” That invited a host stamp that would unlock **listing** while the live set was still unnamed — a parsed-from-empty-env failure by another door.

D26-P0-05’s done bar is one ADR that **states** all three: live set, settlement asset, refuse matrix. This freeze fills those three without inventing contents. T6 already refuse-closes options listing while the law env is empty (`trade.options_settlement_law_unset`). This ADR documents that door; it does **not** dual-edit `services/svc-trade`.

---

## (1) Live instrument set — frozen empty

| Kind                    | Live set under this freeze                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Options (European cash) | **Empty.** No underlyings, expiries, or strikes are published as live.                                           |
| Forex / commodities     | **Empty as settleable production.** Seeded majors in the instrument migration are model/seed, not this live set. |

A later owner stamp may publish a non-empty set. That stamp is a new ruling (and still sits under P0-06 catalogue law). Until then, engines must not assemble a live set from env, comments, vendor UI, or `PAY_CRYPTO_ASSETS`.

**Modelling ≠ live.** Paper or `pending` rows are honest. Six seed FX majors that appear `active: true` remain **unfundable** on the place path. That is not a listing licence and not a live set.

---

## (2) Settlement asset — frozen unset

| Path                  | Settlement asset under this freeze                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Options cash payoff   | **Unset.** Payoff, when an engine exists, posts through `packages/ledger-client` in an owner-named asset — none is named here. |
| Forex / commodity PnL | **Unset.** DIRECTION §2: production list waits on **true fiat rails**. Euro-stable ≠ rails.                                    |

Empty/unset is the sealed answer, not a hole. Filling it with a default coin is doctrine crime.

---

## (3) Refuse matrix (names on tip — do not rename to look busy)

Empty or unset **must** hit a named refuse. Never a silent list. Never a default asset. Never an IV surface pretending to be settlement. Never a CSV/JSON parse of opaque env into an asset list.

| Situation                                                | Named refuse                          | Residual                                              |
| -------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Options `listMarket`, law env empty/unset                | `trade.options_settlement_law_unset`  | `socket.options-settlement-asset-law` (T6 on tip)     |
| Options `listMarket`, fixing empty                       | `trade.options_fixing_unconfigured`   | D7 owner law — fixing alone must not unlock           |
| Options `listMarket`, terms partial / non-european       | `trade.options_terms_incomplete`      | DB `markets_options_terms_ck`                         |
| Options order while no engine                            | `trade.market_kind_unsupported`       | engine not this ADR                                   |
| FX/commodity production list or non-paper place          | `trade.unsettled_asset_class_listing` | `socket.forex-settlement` (this freeze **and** rails) |
| Opaque env parsed as live set / coins / matrix rows      | **Forbidden**                         | Not a code — revert. Empty means refuse by name.      |
| Invented settlement asset in source / env seed / compose | **Forbidden**                         | Doctrine fail. Revert.                                |

T6 already wires the options listing refuses. This ADR does not change that code. D7 fixing remains a second door after a **later** owner stamp — not after this freeze.

---

## Opaque env law (load-bearing)

`TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` stays **empty in committed defaults** and **empty under this freeze**.

- Empty → `trade.options_settlement_law_unset`. That is the correct production posture until a later owner ruling publishes a non-empty live set **and** a named settlement asset.
- Non-empty, if an operator later sets it, is an opaque id only. **Never parse** it for asset ids, pair lists, or refuse-matrix cells. Putting `"USDT"` in the default env is inventing the settlement asset.
- This freeze **does not** authorize setting the stamp merely because this file landed. “ADR exists” ≠ “live set published.”

`TRADE_OPTIONS_SETTLEMENT_FIXING` is a second opaque string (D7). It is not a live set and not a settlement asset.

---

## What remains sealed from 2026-08-13 (shape)

1. **Product title is mechanical payoff, not a pricing engine.** v1 options are European, cash-settled, full collateral. No IV surface. No American exercise.
2. **One book.** Options and forex do not get a second matching engine or a Java wallet table. D-S-06 holds.
3. **Listing is not trading.** Even after a later owner stamp + D7 + complete terms, `assertTradable` still refuses options orders until a real options engine exists.
4. **Stablecoin substitution is forbidden as FX settlement.** `PAY_CRYPTO_ASSETS` mapping EUR → a euro-ticker crypto asset does not close `socket.forex-settlement`.
5. **Same engine.** Forex quote convention / tick / lot / schedule live on the instrument model. Settlement is the missing rail, not a missing book.

---

## What remains owner-open (not inventable here)

- A **non-empty** live set (later stamp; still under P0-06).
- A **named** settlement asset id (later stamp or market-row field — **not** a parse of today’s opaque env).
- D7 fixing content.
- Fiat rail vendor, BIN, and which fiat currencies those rails actually settle (Class X / commercial).
- Options engine, partial-margin options (v1 is full collateral), and any new ledger recipe names for option premium/payoff (DIRECTION §8 item 6).

---

## What agents may do without asking again

- Keep and deepen the refuse paths and tests that blank stamps never list options and never production-place FX.
- Cite this ADR (this freeze) on any new options/forex entry.

## What agents must not do

- Commit a default settlement asset (USDT/USDC/USD/IFC/quote-as-cash) in env examples, compose, or listing code.
- Treat this freeze as licence to set `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` on a host.
- Treat `PAY_CRYPTO_ASSETS` euro-stable as FX rails.
- Mark `trade.options` or `trade.forex` Done because this ADR landed or because T6 refuse-closes.
- Parse `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` for a live set.
- Dual-edit `services/svc-trade` on this mountain while #1946 and other Denon trade lanes are open.
- Build an IV surface or American options to “complete” T6.

---

## Proof on tip (already; this ADR does not dual-edit trade)

- Options listing socket: `services/svc-trade/src/spot/options-listing.ts` — T6 refuse-closes until this law env is empty-named.
- Forex socket: `services/svc-trade/src/spot/forex-settlement.ts`
- Listing policy adjacency: D26-P0-06 ADR
- Tracker sockets: `socket.options-settlement-asset-law`, `socket.forex-settlement`

---

## How a later owner click thaws listing (not this PR)

1. This freeze is on main.
2. Owner publishes a **non-empty live set** and a **named settlement asset** in a later ruling (not by stuffing coins into opaque env).
3. Operator may then set `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` to an opaque id on that deploy. Still never parsed.
4. Operator sets `TRADE_OPTIONS_SETTLEMENT_FIXING` (D7 — still owner).
5. Owner catalogues specific option markets under P0-06.
6. Forex production still waits on **fiat rails**, not on step 3 alone.

Steps 2–6 are not agent craft. Step 6 is not a stablecoin.
