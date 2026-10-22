import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { sovereignEscrowAbi } from './abi.js';
import {
  EscrowBuildError,
  buildDispute,
  buildLock,
  buildOpen,
  buildRefund,
  buildRelease,
  buildSettleTimeout,
  type BuildOpenInput,
} from './build.js';

const ESCROW = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const BUYER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const ARBITER = '0x5555555555555555555555555555555555555555';
const FEE_TO = '0x6666666666666666666666666666666666666666';

const base = (o: Partial<BuildOpenInput> = {}): BuildOpenInput => ({
  escrow: ESCROW,
  seller: SELLER,
  buyer: BUYER,
  token: TOKEN,
  amount: '12.5',
  tokenDecimals: 6,
  arbiter: ARBITER,
  feeRecipient: FEE_TO,
  feeBps: 25,
  disputeWindowSeconds: 86_400,
  timeoutDisposition: 'refund_seller',
  dealRef: 'p2p-trade-1',
  ...o,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof EscrowBuildError ? e.code : 'other';
  }
  return undefined;
}

describe('escrow builders (RC-p2p-01)', () => {
  it('buildOpen encodes open() with base units and returns the expected DealOpened fields', () => {
    const { call, expectedDealOpened } = buildOpen(base());
    expect(call.to).toBe(ESCROW);
    expect(call.value).toBe('0');
    const decoded = decodeFunctionData({ abi: sovereignEscrowAbi, data: call.data });
    expect(decoded.functionName).toBe('open');
    expect(decoded.args).toEqual([BUYER, TOKEN, 12_500_000n, ARBITER, FEE_TO, 25, 86_400, 0]);
    expect(expectedDealOpened).toMatchObject({
      seller: SELLER,
      buyer: BUYER,
      amount: '12500000',
      timeoutDisposition: 'refund_seller',
      dealRef: 'p2p-trade-1',
    });
  });

  it('encodes release_buyer as disposition 1 and a zero fee with no recipient', () => {
    const { call } = buildOpen(base({ timeoutDisposition: 'release_buyer', feeBps: 0, feeRecipient: null }));
    const decoded = decodeFunctionData({ abi: sovereignEscrowAbi, data: call.data });
    expect(decoded.args?.[7]).toBe(1);
    expect(decoded.args?.[4]).toBe('0x0000000000000000000000000000000000000000');
  });

  it('refuses what the contract would revert on, and blanks, with typed codes', () => {
    expect(code(() => buildOpen(base({ buyer: SELLER })))).toBe('protocol.escrow_parties_invalid');
    expect(code(() => buildOpen(base({ buyer: '0x0000000000000000000000000000000000000000' })))).toBe('protocol.escrow_address_invalid');
    expect(code(() => buildOpen(base({ escrow: 'nope' })))).toBe('protocol.escrow_address_invalid');
    expect(code(() => buildOpen(base({ amount: '0' })))).toBe('protocol.escrow_amount_invalid');
    expect(code(() => buildOpen(base({ amount: '1.1234567' })))).toBe('protocol.escrow_amount_invalid');
    expect(code(() => buildOpen(base({ amount: 12.5 as unknown as string })))).toBe('protocol.escrow_amount_invalid');
    expect(code(() => buildOpen(base({ amount: '1e3' })))).toBe('protocol.escrow_amount_invalid');
    expect(code(() => buildOpen(base({ amount: (1n << 128n).toString(), tokenDecimals: 0 })))).toBe('protocol.escrow_amount_invalid');
    expect(code(() => buildOpen(base({ feeBps: 10_001 })))).toBe('protocol.escrow_fee_invalid');
    expect(code(() => buildOpen(base({ feeBps: 25, feeRecipient: null })))).toBe('protocol.escrow_fee_invalid');
    expect(code(() => buildOpen(base({ disputeWindowSeconds: 0 })))).toBe('protocol.escrow_window_invalid');
    expect(code(() => buildOpen(base({ dealRef: ' ' })))).toBe('protocol.escrow_deal_ref_required');
    expect(code(() => buildOpen(base({ timeoutDisposition: 'maybe' as never })))).toBe('protocol.escrow_parties_invalid');
  });

  it.each([
    ['lock', buildLock],
    ['release', buildRelease],
    ['refund', buildRefund],
    ['dispute', buildDispute],
    ['settleTimeout', buildSettleTimeout],
  ] as const)('%s encodes the deal id and never carries value', (name, build) => {
    const call = build(ESCROW, '42');
    expect(call.value).toBe('0');
    const decoded = decodeFunctionData({ abi: sovereignEscrowAbi, data: call.data });
    expect(decoded.functionName).toBe(name);
    expect(decoded.args).toEqual([42n]);
    expect(code(() => build(ESCROW, '-1'))).toBe('protocol.escrow_deal_id_invalid');
    expect(code(() => build(ESCROW, '01'))).toBe('protocol.escrow_deal_id_invalid');
    expect(code(() => build('0x0000000000000000000000000000000000000000', '1'))).toBe('protocol.escrow_address_invalid');
  });
});
