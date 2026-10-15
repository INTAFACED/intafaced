import type { Sql } from 'postgres';
import type { ScreeningProvider } from '@intafaced/screening';
import { PayScreeningService } from './service.js';

/** Explicit synthetic provider for legacy KYB lifecycle tests; never imported by the runtime. */
export function syntheticKybScreening(sql: Sql): PayScreeningService {
  const refs = new Set([
    'dossier-acme-1',
    'd1',
    'd2',
    'case-abc',
    'case-live',
    'case-live-ops',
    'case-live-ops-2',
    'case-p10',
    'TEST-DOSSIER',
  ]);
  const party = { name: 'TEST DATA merchant', country: 'AA', registration: 'TEST-REGISTRATION', identityKycTier: 'full' as const };
  const provider: ScreeningProvider = {
    id: 'fixture-test-data',
    mode: 'fixture',
    async resolveParty(reference) {
      return refs.has(reference.kybRef) ? party : null;
    },
    async screenParty(input) {
      return input.name === party.name && input.country === party.country && input.registration === party.registration
        ? 'pass'
        : 'unavailable';
    },
    async screenWallet(input) {
      return input.chain === 'eip155:31337' && input.address === '0x0000000000000000000000000000000000000f02' ? 'pass' : 'unavailable';
    },
  };
  return new PayScreeningService({
    sql,
    provider,
    env: { APP_ENV: 'test', INTAFACED_SCREENING_FAIL_CLOSED: 'off', PAY_CRYPTO_CHAIN_ID: '31337' },
  });
}
