import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import {
  canonicalDecimal,
  keys,
  onStep,
  partOf,
  preparedAnswerSchema,
  submitAnswerSchema,
  sumKnown,
  venuePreviewSchema,
  venueStatusSchema,
  walletTypedData,
} from './venue-api';
import { closeWorstPrice, totalToCommit } from '../../screens/trade/futures/VenueFuturesDesk';
import { refuseReason } from '../protocol/wallet/eip1193';

// The TEST venue simulator's payload shape (packages/venue-sim/src/signing.ts): EIP712Domain left implicit.
const SIM_TYPED = {
  domain: { name: 'INTAFACED TEST venue simulator', version: '1', chainId: 84532 },
  types: {
    Action: [
      { name: 'venue', type: 'string' },
      { name: 'owner', type: 'string' },
      { name: 'subAccount', type: 'string' },
      { name: 'signer', type: 'string' },
      { name: 'signerRole', type: 'string' },
      { name: 'kind', type: 'string' },
      { name: 'payload', type: 'string' },
      { name: 'nonce', type: 'string' },
    ],
  },
  primaryType: 'Action',
  message: {
    venue: 'test-venue',
    owner: '0x00000000000000000000000000000000000000aa',
    subAccount: '',
    signer: '0x00000000000000000000000000000000000000aa',
    signerRole: 'owner',
    kind: 'place_order',
    payload: '{"amount":"0.1"}',
    nonce: '1',
  },
};
const OWNER = '0x00000000000000000000000000000000000000AA';

describe('venue client', () => {
  it('declares EIP712Domain so the wallet signs the digest the venue checks, and the sheet accepts it', () => {
    const asWallet = walletTypedData(SIM_TYPED);
    expect(asWallet.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ]);
    const venueDigest = hashTypedData(SIM_TYPED as Parameters<typeof hashTypedData>[0]);
    const walletDigest = hashTypedData(asWallet as unknown as Parameters<typeof hashTypedData>[0]);
    expect(walletDigest).toBe(venueDigest);
    expect(refuseReason({ kind: 'typedData', typedData: asWallet })).toBeNull();
  });

  it('makes business keys from the owner, market and the reviewed draft, never a random id, and the same draft gives the same key', () => {
    const a = keys.order(OWNER, 'BTC-USDC', 'abc1');
    expect(a).toBe('order:0x00000000000000000000000000000000000000aa:btc-usdc:abc1');
    expect(keys.order(OWNER, 'BTC-USDC', 'abc1')).toBe(a);
    expect(keys.cancel(a)).toBe(`cancel:${a}`);
    // A withdrawal's step-up request id (`venue.withdraw:<key>`) must stay within identity's 128 characters.
    expect(`venue.withdraw:${keys.withdraw(OWNER, 'mhxyz1230')}`.length).toBeLessThanOrEqual(128);
    expect(a).toMatch(/^[a-z][a-z0-9-]*:.+$/);
  });

  it('sends the canonical decimal identity and the door hash, and checks tick and lot exactly', () => {
    expect(canonicalDecimal('10.000')).toBe('10');
    expect(canonicalDecimal(' 0.10 ')).toBe('0.1');
    expect(onStep('0.1', '0.0001')).toBe(true);
    expect(onStep('0.00015', '0.0001')).toBe(false);
    expect(onStep('0', '1')).toBe(false);
    expect(partOf('0.1', 40, '0.0001')).toBe('0.04');
    expect(partOf('0.0003', 40, '0.0001')).toBe('0.0001');
  });

  it('sums only figures the venue published; one not known makes the sum not known', () => {
    expect(
      sumKnown([
        { known: true, value: '1.5' },
        { known: true, value: '2' },
      ]),
    ).toBe('3.5');
    expect(sumKnown([{ known: true, value: '1.5' }, { known: false }])).toBeNull();
  });

  it('totals a perpetual review from the venue figures, or not known', () => {
    const preview = venuePreviewSchema.parse({
      symbol: 'BTC-PERP',
      kind: 'perpetual',
      lock: { asset: 'USDC', amount: '603.3' },
      role: 'taker',
      venueFee: { known: true, value: { asset: 'USDC', amount: '2.7' } },
      builderFee: { known: true, value: { asset: 'USDC', amount: '0.3' } },
      perpetual: {
        leverageBps: 100000,
        marginMode: 'isolated',
        initialMargin: { known: true, value: '601' },
        liquidationPrice: { known: false },
      },
    });
    expect(totalToCommit(preview)).toBe('604');
    expect(totalToCommit({ ...preview, venueFee: { known: false } })).toBeNull();
  });

  it('puts a close’s worst price on the tick, against the position', () => {
    const position = {
      symbol: 'BTC-PERP',
      side: 'long' as const,
      size: '0.1',
      entryPrice: '60010',
      markPrice: '60000',
      unrealisedPnl: '-1',
      marginMode: 'isolated' as const,
      margin: '600',
      leverageBps: 100000,
      liquidationPrice: { known: false as const },
    };
    expect(closeWorstPrice(position, '1')).toBe('57000');
    expect(closeWorstPrice({ ...position, side: 'short' }, '1')).toBe('63000');
  });

  it('reads the door’s answers: status off, a prepared action, and an answer that is not definite', () => {
    expect(venueStatusSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(
      venueStatusSchema.parse({
        enabled: true,
        available: true,
        venue: { id: 'test-venue', displayName: 'TEST venue', proofLevel: 'simulator' },
        test: true,
        label: 'TEST',
        chainId: 84532,
        builder: { address: '0x7e57000000000000000000000000000000000b1d', feeBps: '0.5' },
      }),
    ).toMatchObject({ available: true, chainId: 84532 });
    const prepared = preparedAnswerSchema.parse({
      actionKey: 'order:x:btc-usdc:1',
      prepared: {
        venueId: 'test-venue',
        signer: { role: 'owner', address: OWNER.toLowerCase() },
        nonce: '1',
        venueClientOrderId: '0x00000000000000000000000000000001',
        typedData: SIM_TYPED,
        digest: `0x${'ab'.repeat(32)}`,
        extra: 'kept out',
      },
      reused: true,
      signed: true,
      lastOutcome: { definite: false, reason: 'timeout' },
    });
    expect(prepared.lastOutcome).toEqual({ definite: false, reason: 'timeout' });
    expect(
      submitAnswerSchema.parse({ actionKey: 'k:1', outcome: { definite: false, reason: 'already_submitted' }, readBack: { nonce: '1' } })
        .readBack,
    ).toEqual({
      nonce: '1',
    });
    // Money is a decimal string on the wire: a JSON number is refused.
    expect(() =>
      venuePreviewSchema.parse({
        symbol: 'x',
        kind: 'spot',
        lock: { asset: 'USDC', amount: 1 },
        role: 'maker',
        venueFee: { known: false },
        builderFee: { known: false },
        perpetual: null,
      }),
    ).toThrow();
  });
});
