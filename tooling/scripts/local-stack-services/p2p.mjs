import path from 'node:path';
import { profileEnvFor } from '../owner-settings.mjs';

export default ({ c, secrets, dbUrl, urlOf, PORTS, STATE }) => ({
  name: 'p2p',
  env: () => ({
    ...c('svc-p2p', PORTS.p2p),
    DATABASE_URL: dbUrl('svc_p2p', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    // Offer caps stay unset (owner-unpublished). P2P_FEE_BPS=0 is an explicit LOCAL TEST free cut:
    // parseOwnerIntegerEnv accepts 0, and trades.take posts a 0 bps cut instead of refusing fee_bps_unset.
    // The clocks below have no default and the service will not boot without them; they are LOCAL TEST
    // values (the figures the service's own messages name), not owner decisions.
    // LOCAL_TEST_KMS is this service only. The key file is written under the stack state dir on first boot.
    LOCAL_TEST_KMS: '1',
    LOCAL_TEST_KMS_DIR: path.join(STATE, 'p2p-kms'),
    P2P_FEE_BPS: '0',
    P2P_ESCROW_DEADLINE_SECONDS: '120',
    // 180, not the 900 a person would get: the order-history journey waits for a real payment timeout.
    P2P_PAYMENT_DEADLINE_SECONDS: '180',
    P2P_RELEASE_DEADLINE_SECONDS: '1800',
    P2P_DISPUTE_SLA_SECONDS: '604800',
    P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: '3600',
    P2P_SWEEP_INTERVAL_SECONDS: '30',
    P2P_INSTRUMENT_RETENTION_DAYS: '90',
    // Export caps and receipt quotas: the labelled TEST profile (tooling/profiles/test-owner-values/p2p.json).
    ...profileEnvFor('p2p', 'dev'),
  }),
});
