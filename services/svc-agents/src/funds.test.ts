import { describe, expect, it } from 'vitest';
import { FundsUnreadError, fundsRefusalParams, readFunds } from './funds.js';

const WALLET = '0x00000000000000000000000000000000000a11ce';
const reading = {
  kind: 'wallet',
  available: 5n * 10n ** 15n,
  token: 'TESTUSD',
  method: { kind: 'wallet', address: WALLET },
  source: { kind: 'chain', chainId: 84532, block: 42n },
  asOf: '2026-11-09T00:00:00.000Z',
} as const;

describe('readFunds', () => {
  it('a plain amount is a ledger reading', async () => {
    expect(await readFunds(async () => 7n)).toEqual({ ok: true, reading: { kind: 'ledger', available: 7n } });
  });
  it('a wallet reading passes through whole', async () => {
    expect(await readFunds(async () => reading)).toEqual({ ok: true, reading });
  });
  it('a FundsUnreadError keeps its method and reason; any other throw is an unread ledger balance', async () => {
    expect(
      await readFunds(async () => {
        throw new FundsUnreadError({ kind: 'wallet', address: WALLET }, 'chain_unreachable');
      }),
    ).toEqual({ ok: false, method: { kind: 'wallet', address: WALLET }, reason: 'chain_unreachable' });
    expect(
      await readFunds(async () => {
        throw new Error('ledger down');
      }),
    ).toEqual({ ok: false, method: null, reason: null });
  });
});

describe('fundsRefusalParams', () => {
  it('a ledger reading keeps today’s params exactly', () => {
    expect(fundsRefusalParams('0.0102', 'USDT', { ok: true, reading: { kind: 'ledger', available: 1n } })).toEqual({
      worstCase: '0.0102',
      asset: 'USDT',
    });
    expect(fundsRefusalParams('0.0102', 'USDT', { ok: false, method: null, reason: null })).toEqual({ worstCase: '0.0102', asset: 'USDT' });
  });
  it('a wallet reading names the method, the figure, its source and its as-of time', () => {
    expect(fundsRefusalParams('0.0102', 'USDT', { ok: true, reading })).toEqual({
      worstCase: '0.0102',
      asset: 'USDT',
      method: 'wallet',
      address: WALLET,
      available: '0.005',
      token: 'TESTUSD',
      source: 'chain',
      chainId: 84532,
      block: '42',
      asOf: '2026-11-09T00:00:00.000Z',
    });
  });
  it('an unread wallet names the method and the reason', () => {
    expect(
      fundsRefusalParams('0.0102', 'USDT', { ok: false, method: { kind: 'wallet', address: WALLET }, reason: 'wallet_unlinked' }),
    ).toEqual({ worstCase: '0.0102', asset: 'USDT', method: 'wallet', address: WALLET, reason: 'wallet_unlinked' });
    expect(fundsRefusalParams('1', 'USDT', { ok: false, method: null, reason: 'method_unread' })).toEqual({
      worstCase: '1',
      asset: 'USDT',
      reason: 'method_unread',
    });
  });
});
