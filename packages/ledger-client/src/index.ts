/**
 * @intafaced/ledger-client — THE only way any service touches balances.
 *
 * Doctrine §0.6: "Ledger is law. No module holds its own balance. Every value
 * movement anywhere in the OS is a double-entry ledger transaction in the Core.
 * No exceptions — not for fees, not for rewards, not for gas."
 *
 * If you are reading this because you want a balance somewhere else: the answer
 * is no. Add an account kind or a recipe here instead.
 */
export * from './money.js';
export * from './types.js';
export * from './client.js';
export * from './accounts.js';
export * from './memory-ledger.js';
export * from './sharding.js';
export * from './http-errors.js';
export * from './http-client.js';
export * from './posted-movement.js';
export * from './recipes/index.js';
