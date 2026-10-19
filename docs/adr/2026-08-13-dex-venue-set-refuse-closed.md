# ADR: dex venue set — empty is refuse, not a silent router

**Status:** **Accepted — 2026-08-13 (D26-P0-03 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-03 — `socket.dex-venue-set` one sentence.  
**Packet:** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §2.  
**Does not invent:** which CEX, which CLOB address, or a seeded `DEX_EXTERNAL_VENUES` row. Doctrine §0.4 / §0.7 — no vendor names in source.

---

## The decision (one sentence)

> **The platform quotes only venues the owner has published. The shipped default set is empty. Empty is `dex.quote.no_venue_available` (503), not a cached price, not a fake book, not a screen that looks alive. Agents do not fill `DEX_EXTERNAL_VENUES`. Closing `socket.dex-venue-set` is an operator publish on a durable host, not a craft PR.**

This is settled. The router is finished. The set is not.

---

## Why this is the ruling, not a named venue

The packet recommended naming “the one venue we already have a working adapter for.” Naming it in an ADR would put a partner identity in law and in git. That is §0.7 crime dressed as unblock.

The honest owner sentence that does **not** invent the catalogue:

**Refuse-closed until published.** Same shape as copy jurisdictions (P0-15). Content stays deploy config. Mechanism stays 503.

A live probe already proved: one reachable row in `DEX_EXTERNAL_VENUES` is enough for a real quote, flagged `degraded` / `singleVenue` / `custodialLegs`. That proof is **capability**, not a licence to commit the row.

---

## What is sealed

1. **Three kinds, all may be dark.** `intachain-clob` (contracts / indexer — Shehzad / `socket.clob-contracts`). `internal-book` (matching depth — ops / mm-bot). `external` (`DEX_EXTERNAL_VENUES`, default `[]`).
2. **Empty default is load-bearing.** A service that had no outbound egress does not silently acquire it.
3. **Refuse vocabulary stays.** `dex.quote.no_venue_available`. Disclose dead venues. Never soften 503 to make UI green.
4. **Single published venue is honest** when the owner publishes it — the response already says `singleVenue`. An empty set presented as a router is the lie.
5. **No ccxt / no invented mids.** Existing quote path stands.

---

## What remains owner-open (Nitro / ops click)

- The actual `DEX_EXTERNAL_VENUES` JSON on a durable host.
- INDEXER_VENUE_ADDRESS / CLOB contracts (Shehzad plane — babysit only).
- Whether internal-book is allowed as a quote source in production (custodial; already disclosed).

Until that click, `socket.dex-venue-set` stays a socket. `dex.quote-router` stays not Done.

---

## What agents must not do

- Commit a venue URL, slug, or partner name into env examples or source.
- Treat the 2026-08-03 probe as production publish.
- Mark `socket.dex-venue-set` or `dex.quote-router` Done because this ADR landed.

---

## Proof on tip (already; this ADR does not dual-edit dex)

- `services/svc-dex/src/env.ts` — `DEX_EXTERNAL_VENUES` default empty
- `services/svc-dex/src/quote/quote-service.ts` — `dex.quote.no_venue_available`
- Tracker: `socket.dex-venue-set`
