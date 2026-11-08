import { describe, expect, it } from 'vitest';
import {
  OWNER_ONLY_INTENTS,
  VenueRefusalError,
  assertSignatureMatches,
  assertSignerMaySign,
  refuseTestVenueOutsideTest,
  venueClientOrderId,
  type PreparedVenueAction,
  type UserVenueDescriptor,
  type VenueIntent,
  type VenueSigner,
} from './index.js';

const owner: VenueSigner = { role: 'owner', address: '0xowner' };
const agent: VenueSigner = { role: 'agent', address: '0xagent' };

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal.code;
  }
  throw new Error('expected a VenueRefusalError, nothing was thrown');
}

describe('venueClientOrderId', () => {
  it('maps a business key to a fixed 128-bit hex id, the same on every retry', () => {
    const a = venueClientOrderId('test-sim', 'order:user-1:desk-7:1');
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
    expect(venueClientOrderId('test-sim', 'order:user-1:desk-7:1')).toBe(a);
    expect(venueClientOrderId('test-sim', '  order:user-1:desk-7:1  ')).toBe(a);
  });

  it('gives a different id for a different intent, and per venue', () => {
    const a = venueClientOrderId('test-sim', 'order:user-1:desk-7:1');
    expect(venueClientOrderId('test-sim', 'order:user-1:desk-7:2')).not.toBe(a);
    expect(venueClientOrderId('hyperliquid-testnet', 'order:user-1:desk-7:1')).not.toBe(a);
  });

  it('refuses a blank key, a bare UUID and a key with no business shape', () => {
    expect(refusalCode(() => venueClientOrderId('test-sim', ''))).toBe('invalid_client_order_key');
    expect(refusalCode(() => venueClientOrderId('test-sim', '   '))).toBe('invalid_client_order_key');
    expect(refusalCode(() => venueClientOrderId('test-sim', '3f2b8c1e-9d4a-4b7e-8f6a-1c2d3e4f5a6b'))).toBe('invalid_client_order_key');
    expect(refusalCode(() => venueClientOrderId('test-sim', 'justanid'))).toBe('invalid_client_order_key');
  });
});

describe('assertSignerMaySign', () => {
  const intents: VenueIntent[] = [
    {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: 1n,
      price: 1n,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: 'order:u:1',
      leverageBps: null,
      marginMode: null,
    },
    { kind: 'amend_order', symbol: 'BTC-USDC', clientOrderKey: 'order:u:1', amount: 1n, price: 1n },
    { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:u:1' },
    { kind: 'withdraw', asset: 'USDC', amount: 1n, destination: '0xowner', withdrawalKey: 'withdraw:u:1' },
    { kind: 'approve_builder_fee', builder: '0xbuilder', maxFeeBps: 1n },
    { kind: 'approve_agent', agentAddress: '0xagent', agentName: 'bot' },
    { kind: 'revoke_agent', agentAddress: '0xagent' },
  ];

  it.each(intents.map((intent) => [intent.kind, intent] as const))('the owner may sign %s', (_kind, intent) => {
    expect(() => assertSignerMaySign('test-sim', owner, intent)).not.toThrow();
  });

  it.each(intents.map((intent) => [intent.kind, intent] as const))(
    'an agent signing %s is refused only when it is owner-only',
    (kind, intent) => {
      if (OWNER_ONLY_INTENTS.has(kind)) {
        expect(refusalCode(() => assertSignerMaySign('test-sim', agent, intent))).toBe('agent_not_permitted');
      } else {
        expect(() => assertSignerMaySign('test-sim', agent, intent)).not.toThrow();
      }
    },
  );

  it('keeps withdrawal and every approval owner-only', () => {
    expect([...OWNER_ONLY_INTENTS].sort()).toEqual(['approve_agent', 'approve_builder_fee', 'revoke_agent', 'withdraw']);
  });
});

describe('assertSignatureMatches', () => {
  const prepared: PreparedVenueAction = {
    venueId: 'test-sim',
    account: { venueId: 'test-sim', owner: '0xowner', subAccount: null },
    signer: { role: 'owner', address: '0xOwner' },
    intent: { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:u:1' },
    nonce: '1',
    venueClientOrderId: null,
    typedData: {},
    digest: '0xABCD',
    builderFee: null,
    preparedAt: new Date(0),
  };

  it('accepts the prepared digest signed by the prepared signer, case-insensitively', () => {
    expect(() => assertSignatureMatches(prepared, { digest: '0xabcd', signature: '0x01', signedBy: '0xowner' })).not.toThrow();
  });

  it('refuses a signature over a different payload', () => {
    expect(refusalCode(() => assertSignatureMatches(prepared, { digest: '0xabce', signature: '0x01', signedBy: '0xowner' }))).toBe(
      'signer_not_authorised',
    );
  });

  it('refuses a signature from another key', () => {
    expect(refusalCode(() => assertSignatureMatches(prepared, { digest: '0xabcd', signature: '0x01', signedBy: '0xagent' }))).toBe(
      'signer_not_authorised',
    );
  });
});

describe('refuseTestVenueOutsideTest', () => {
  const sim: UserVenueDescriptor = {
    id: 'test-sim',
    displayName: 'TEST venue simulator',
    kind: 'external-dex',
    sequencedDepth: true,
    test: true,
    proofLevel: 'simulator',
  };
  const live: UserVenueDescriptor = { ...sim, id: 'live', displayName: 'Live', test: false, proofLevel: 'live' };

  it.each(['dev', 'test'])('allows a TEST venue in APP_ENV %s', (env) => {
    expect(() => refuseTestVenueOutsideTest(sim, env)).not.toThrow();
  });

  it.each([['prod'], ['staging'], [''], ['TEST'], [undefined]])('refuses a TEST venue in APP_ENV %j', (env) => {
    expect(refusalCode(() => refuseTestVenueOutsideTest(sim, env))).toBe('test_venue_outside_test');
  });

  it('never refuses a live venue on these grounds', () => {
    expect(() => refuseTestVenueOutsideTest(live, 'prod')).not.toThrow();
  });
});
