/**
 * p2p.access.status payload (P-order-03-be).
 *
 * Read-only security posture derived from the configured instrument key
 * provider. Nothing is stored and no key material is ever returned: only
 * whether a production instrument key is set and whether the local-test seal
 * is active. No production (owner) KMS exists yet, so production key presence
 * is always `owner_decision_pending` — never inferred from a flag.
 */
export type AccessStatus = {
  productionInstrumentKey: 'owner_decision_pending' | 'set';
  /** True only for the local-test seal. Offers and methods carry a TEST label. */
  localTestKms: boolean;
  /** Present while the production key is pending, so controls show the allowlisted copy. */
  reason: 'p2p.owner_decision_pending' | null;
};

export function accessStatus(instrumentKeyProvider: 'none' | 'local-test' | null | undefined): AccessStatus {
  return {
    productionInstrumentKey: 'owner_decision_pending',
    localTestKms: instrumentKeyProvider === 'local-test',
    reason: 'p2p.owner_decision_pending',
  };
}
