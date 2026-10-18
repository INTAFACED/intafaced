/**
 * The rail layer (§6.1, Doctrine §0.4).
 *
 * Everything external to svc-pay enters through here and nowhere else. The core
 * imports `RailAdapter` and `RailRegistry`; it never imports a concrete adapter,
 * which is what keeps §6.1's "drop in later with zero core changes" true rather
 * than aspirational.
 */
export * from './rail-adapter.js';
export * from './registry.js';
export * from './chain-port.js';
export * from './posture.js';
export * from './crypto-native.js';
export * from './card-sandbox.js';
export * from './bank-payout.js';
export * from './broadcast-store.js';
export * from './durable-broadcast.js';
export * from './evm-assets.js';
export * from './evm-chain.js';
export * from './chain-watcher.js';
export * from './deposit-reorg.js';
export { signPayload, verifySignature, type SignatureCheck } from './webhook-signature.js';
export { runRailAdapterConformance, type RailHarness } from './conformance.js';
export { RailHealthProbeLoop, nextProbeDelayMs, RAIL_PROBE_INTERVAL_MS, RAIL_PROBE_MAX_INTERVAL_MS } from './rail-health-probe.js';
