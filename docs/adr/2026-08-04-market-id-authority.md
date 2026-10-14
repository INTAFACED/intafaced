# ADR: which service decides what a market is

**Status:** accepted  
**Status note:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Supersedes in scope:** nothing. **Implemented by:** [#727](https://github.com/Phantom-X-007/intafaced/pull/727), which shipped before this was written down — this ADR seals the decision that PR made.

---

## The decision

> **`svc-trade`'s `trade.markets` table is the market registry. It is the only authority on what is listed.**
>
> Every other service that needs to know whether a market exists reads that registry, directly or through a union that includes it. No service may treat its own local knowledge as the definition of what is listed.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## The failure that made this necessary

`svc-ws` took its market list from `svc-matching`, and `svc-matching` builds its list from **journal replay**. So it knew only markets that had already traded.

The result, measured on a running fleet on 2026-08-03:

```
svc-edge  (from trade.markets):  16 markets
svc-ws    (from the journal):    10 markets
intersection:                     0
```

Both sides held UUIDs from the same conceptual namespace. They disagreed because the journal carried ids from a **previous database seed**, and `trade.markets` had regenerated them with `defaultRandom()`. Not a design mismatch — stale state that nothing reconciled.

A trader could not open a depth stream for any market the exchange actually listed. The blocked state was recorded **26 times across 26 agent cycles** before anyone traced it, because each layer looked locally correct: nginx forwarded, the socket upgraded, the gateway refused an id it had genuinely never heard of.

**The lesson generalises past websockets.** Any service that answers "does this market exist?" from something other than the registry will drift, and the drift is silent in the direction that matters — it refuses real markets rather than accepting fake ones, so it reads as a bug in the caller.

---

## What follows from it

### A listed market that has never traded is a real market

It is subscribable, quotable and displayable. The honest answer for its book is **empty**, not absent, and not an error.

`sequence: 0` with `bids: []` and `asks: []` is a complete, correct answer. Any surface rendering it must say "No bids / No asks" — never a spinner, never an error state, never a fabricated ladder. Six of the sixteen listed markets are in exactly this state today.

### A market id is an opaque token, and it is not the symbol

The registry's `id` is a UUID. The symbol (`BTC/USDT`) is a **display and lookup key**, not an identity.

`svc-ws`'s gateway constrains ids to `^[A-Za-z0-9._:-]{1,64}$`. A `/` is deliberately not in that class, so a CCXT-style symbol **cannot** be passed where an id is expected. That constraint stays. Clients pass `market.id` from the registry response, which they already receive.

Widening the pattern to admit symbols would make two different strings identify the same market on the same wire, and the first bug it produces will be a subscription to a market nobody listed.

### Union, not replacement, when a service must merge sources

`svc-ws` takes the union of the registry and the engine's journal. That is deliberate and is the pattern to copy:

- registry unreachable → every market that has traded still streams
- engine unreachable → every listed market opens on an empty book
- both unreachable → refuse, and keep the last known list rather than reporting zero

**Reporting zero markets because a source was unreachable is forbidden.** It delists the exchange on a network blip.

---

## Refuse cases — the part agents get wrong

| Situation                                  | Correct answer                                                      |
| ------------------------------------------ | ------------------------------------------------------------------- |
| Id not in any source                       | **Refuse.** `unknown market "<id>"`, naming the id.                 |
| Listed, never traded                       | **Empty book.** `sequence: 0`, both sides `[]`.                     |
| Upstream returns 404 for a book            | **Empty book.** The market exists; the engine holds no book for it. |
| Upstream returns 400/500/502/503           | **Throw.** Never coerce to empty.                                   |
| Every source unreachable                   | **Refuse**, keep the last known list. Never report zero markets.    |
| Client passes a symbol where an id belongs | **Refuse.** Do not widen the pattern to accept it.                  |

The 404-versus-5xx distinction is the load-bearing one. Mapping _every_ upstream error to "empty" makes a dead endpoint indistinguishable from a quiet market, which is precisely the class of lie this codebase's honesty doctrine exists to prevent.

---

## Non-goals

- **This does not make `svc-matching` wrong.** Its journal-derived list is correct for what it is — markets with engine state. The error was treating it as the answer to a different question.
- **This does not require a shared registry package.** An HTTP read of `GET /api/v1/markets` is sufficient and is what ships. A package can come later if a third consumer appears.
- **This does not route registry reads through `svc-edge`.** The edge proxies that path unchanged, so a hop between two services on one network adds a component that can be down and buys nothing. `svc-trade`'s route is public and unauthenticated, so the reader still holds no credential.
- **This says nothing about INTACORE's on-chain market identity.** When the L1 CLOB lists markets, whether its ids are these ids is an open question and belongs to D-S-06 (matching dual-target law). Until then, this ADR governs the Fiat Plane only.

---

## Done bar

A change satisfies this ADR when:

1. No service determines market existence from anything but the registry, or a union including it.
2. A listed-but-never-traded market returns an empty book end to end, through whatever path the product surface actually uses.
3. Unknown ids are refused by name.
4. A 404 for a book is empty; a 5xx throws. Both are tested.
5. No source's unavailability can cause a report of zero markets.
6. No client passes a symbol where an id is expected.

---

## What agents may implement without asking again

- Reading the registry from any service that needs market existence.
- Adding a union source, provided the failure semantics above hold.
- Wiring a client to `market.id` and rendering an empty book honestly.
- Tests for any refuse case in the table.

## What still needs the owner

- Changing the id **format**, or admitting symbols as ids.
- Making any service other than `svc-trade` authoritative.
- Deciding whether INTACORE market ids are these ids (D-S-06).
- Any change that lets an unreachable source produce an empty or zero market list.
