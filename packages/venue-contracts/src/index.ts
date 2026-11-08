/**
 * @intafaced/venue-contracts — the unified venue schema (§27 INTAFACED CONNECT).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS PACKAGE EXISTS AND CCXT DOES NOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §27: *"Our own CCXT-class layer, built past it: typed, streaming-first,
 * latency-graded, and wired into the ledger. No third-party connectivity
 * library in the money path — Doctrine 5 applies."*
 *
 * There is no `ccxt` in this workspace and that is a decision, not an omission.
 * Three concrete differences, each of which would cost a user money:
 *
 *   · **Money is a `number` there and an `Amount` here.** CCXT's unified surface
 *     parses venue decimal strings to floats before a caller sees them, and the
 *     digits are gone by then. `decimal.ts` REFUSES a JSON number at the wire.
 *   · **Books are polled there and streamed here.** `MarketDataAdapter` has no
 *     poll method (`adapter.ts`), because a polled book has an invisible age
 *     and no sequence numbers to gap-check.
 *   · **Failure is an exception there and a typed exclusion here.** A venue that
 *     is down, stale, rate-limited or desynced is EXCLUDED AND REPORTED
 *     (`errors.ts`), never quietly dropped so the survivors look like consensus.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS AND IS NOT IN HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Types, parsers and pure functions. No transport, no sockets, no venue names.
 * The machinery that uses these — the sequenced book tracker, the rate-limit
 * governor, latency grading, cross-checking and the venue adapters themselves —
 * lives in `@intafaced/venue-adapter`, which depends on this and not the other
 * way round.
 *
 * Value never moves here. Doctrine §0.6: no module holds its own balance, and
 * `account.ts` is an OBSERVATION of a third party's records — read its header
 * before using any type in it.
 */
export * from './decimal.js';
export * from './errors.js';
export * from './market.js';
export * from './book.js';
export * from './rates.js';
export * from './account.js';
export * from './latency.js';
export * from './adapter.js';
export * from './user-venue.js';
export * from './user-venue-wire.js';
