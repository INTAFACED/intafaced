/**
 * p2p.access.status payload (P-order-03-be).
 *
 * Read-only security posture derived from the configured instrument key
 * provider. Nothing is stored and no key material is ever returned: only
 * whether a production instrument key is set and whether the local-test seal
 * is active. No production (owner) KMS exists yet, so production key presence
 * is always `owner_decision_pending` — never inferred from a flag.
 */
import { instrumentKeyHealth } from './instrument-key-provider.js';

export type AccessStatus = {
  /**
   * Narrowed to the pending literal until the owner KMS decision. Widening it
   * (e.g. to a 'set' state) needs a DECISIONS entry first.
   */
  productionInstrumentKey: 'owner_decision_pending';
  /** True only for the local-test seal. Offers and methods carry a TEST label. */
  localTestKms: boolean;
  /** Present while the production key is pending, so controls show the allowlisted copy. */
  reason: 'p2p.owner_decision_pending' | null;
};

/**
 * Fail-closed for every input: an unknown or future provider kind still
 * reports the production key as pending. Only the exact 'local-test' kind sets
 * localTestKms.
 */
export function accessStatus(instrumentKeyProvider: Parameters<typeof instrumentKeyHealth>[0]): AccessStatus {
  return {
    productionInstrumentKey: 'owner_decision_pending',
    // Same source as the health endpoint, so the two can never disagree.
    localTestKms: instrumentKeyHealth(instrumentKeyProvider).instrumentKeyProvider === 'local-test',
    reason: 'p2p.owner_decision_pending',
  };
}
