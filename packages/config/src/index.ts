/**
 * @intafaced/config — env, flags, jurisdiction, screening, fiat registry,
 * network-signal / compliance-queue / freeze-authority / money-kill-surface /
 * marketing-language honesty.
 *
 * Doctrine reminder: this package holds configuration only. No I/O, no db, no
 * network. If something here needs a connection, it belongs in a service.
 */
export * from './modules.js';
export * from './env.js';
export * from './flags.js';
export * from './jurisdiction.js';
export * from './screening.js';
export * from './app-env.js';
export * from './local-test-guard.js';
export * from './production-posture.js';
export * from './fiat.js';
export * from './network-signal.js';
export * from './compliance-queue.js';
export * from './freeze-authority.js';
export * from './money-kill-surface.js';
export * from './marketing-language.js';
