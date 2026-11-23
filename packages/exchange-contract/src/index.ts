/**
 * @intafaced/exchange-contract — the CCXT-compatible public exchange API.
 *
 * This is how the outside world trades on INTAFACED: bots, algo frameworks,
 * third-party terminals, and our own licensed desktop pro terminal
 * (docs/TERMINAL_INTEGRATION.md) all speak this one shape.
 *
 * svc-trade implements `ExchangeApi`. Nothing else may.
 */
export * from './schemas.js';
export * from './api.js';
export * from './symbols.js';
export * from './spine.js';
export * from './market-lifecycle.js';
export * from './market-lifecycle-admission-proof.js';
export * from './matching-submit-order.js';
