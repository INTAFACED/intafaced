import { describe, expect, it } from 'vitest';
import { createScreeningSocket, createFixtureScreeningProvider, type ScreeningProvider } from './index.js';

describe('screening provider socket', () => {
  it('missing providers refuse as unavailable without calling anything', async () => {
    const socket = createScreeningSocket({ appEnv: 'prod' });
    expect(await socket.screenParty({ name: 'TEST DATA Merchant', country: 'AA', registration: 'TEST-1' })).toEqual({
      outcome: 'unavailable',
      provider: 'unconfigured',
      fixture: false,
    });
    expect(await socket.resolveParty({ merchantId: 'merchant', kybRef: 'dossier' })).toBeNull();
  });

  it('fixtures are explicit, visibly labelled, exact-match only and unusable outside dev/test', async () => {
    const party = { name: 'TEST DATA Merchant', country: 'AA', registration: 'TEST-1', identityKycTier: 'full' as const };
    const provider = createFixtureScreeningProvider({
      appEnv: 'test',
      cases: [
        {
          reference: { merchantId: 'merchant', kybRef: 'test-dossier' },
          party,
          partyOutcome: 'pass',
          wallets: [{ address: 'test-address', chain: 'test-chain', outcome: 'review' }],
        },
      ],
    });
    const socket = createScreeningSocket({ appEnv: 'test', provider });
    expect(await socket.screenParty(party)).toEqual({ outcome: 'pass', provider: 'fixture-test-data', fixture: true });
    expect(await socket.screenWallet({ address: 'test-address', chain: 'test-chain' })).toMatchObject({ outcome: 'review', fixture: true });
    expect(await socket.screenParty({ ...party, registration: 'unknown' })).toMatchObject({ outcome: 'unavailable' });
    expect(await createScreeningSocket({ appEnv: undefined, provider }).screenParty(party)).toMatchObject({
      outcome: 'unavailable',
      fixture: false,
    });
    for (const appEnv of ['prod', 'staging', 'production', 'unknown', '']) {
      expect(await createScreeningSocket({ appEnv, provider }).screenParty(party)).toMatchObject({
        outcome: 'unavailable',
        fixture: false,
      });
    }
    expect(() => createFixtureScreeningProvider({ appEnv: 'staging', cases: [] })).toThrow('screening.fixture_requires_explicit_dev_test');
  });

  it('provider errors, malformed answers and timeouts fail closed without exposing sensitive errors', async () => {
    const provider: ScreeningProvider = {
      id: 'test-boundary',
      mode: 'live',
      async resolveParty() {
        return { name: 'sensitive', country: 'XX', registration: 'sensitive', identityKycTier: 'none' };
      },
      async screenParty() {
        throw new Error('sensitive provider error');
      },
      async screenWallet() {
        return 'unknown' as 'pass';
      },
    };
    const socket = createScreeningSocket({ appEnv: 'test', provider, timeoutMs: 5 });
    expect(await socket.resolveParty({ merchantId: 'merchant', kybRef: 'dossier' })).toBeNull();
    const brokenResolver = createScreeningSocket({
      provider: {
        ...provider,
        resolveParty: async () => {
          throw new Error('sensitive dossier');
        },
      },
    });
    expect(await brokenResolver.resolveParty({ merchantId: 'merchant', kybRef: 'dossier' })).toBeNull();
    expect(await socket.screenParty({ name: 'sensitive', country: 'AA', registration: 'sensitive' })).toMatchObject({
      outcome: 'unavailable',
    });
    expect(await socket.screenWallet({ address: 'sensitive', chain: 'test-chain' })).toMatchObject({ outcome: 'unavailable' });
    const hanging = createScreeningSocket({ provider: { ...provider, screenWallet: () => new Promise(() => undefined) }, timeoutMs: 5 });
    expect(await hanging.screenWallet({ address: 'sensitive', chain: 'test-chain' })).toMatchObject({ outcome: 'unavailable' });
  });
});
