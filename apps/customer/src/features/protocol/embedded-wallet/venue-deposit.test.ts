import { describe, expect, it } from 'vitest';
import {
  assetWay,
  checkDeposit,
  depositTransaction,
  estimateNetworkFee,
  paidNetworkFee,
  readNonce,
  readWalletFunds,
  type ChainRead,
  type WalletFunds,
} from './venue-deposit';

// J-wallet-24: what is read from the chain, and what stops a deposit to the venue before anything is signed.

const route = {
  chainId: 84532,
  token: '0x000000000000000000000000000000000000d011',
  tokenDecimals: 6,
  address: '0x00000000000000000000000000000000de905170',
  asset: 'USDC',
  minimum: '5',
  confirmations: 3,
  network: 'TEST chain',
  warning: 'TEST: send only TEST USDC on TEST chain.',
};
const owner = '0x1111111111111111111111111111111111111111';
const hex = (n: bigint) => `0x${n.toString(16)}`;
const funds = (token: bigint | null, gas: bigint | null): WalletFunds => ({
  asOf: '2026-11-21T00:00:00.000Z',
  block: '10',
  token: token === null ? { known: false } : { known: true, units: token, amount: String(token) },
  gas: gas === null ? { known: false } : { known: true, units: gas, amount: String(gas) },
});
const fee = { known: true as const, units: 21_000n, amount: '0.000000000000021' };

describe('readWalletFunds', () => {
  it('reads both balances at one block, with the block time', async () => {
    const asked: [string, unknown[]][] = [];
    const read: ChainRead = async (method, params) => {
      asked.push([method, params]);
      if (method === 'eth_getBlockByNumber') return { number: '0xa', timestamp: hex(1_700_000_000n) };
      if (method === 'eth_call') return hex(100_000_000n);
      if (method === 'eth_getBalance') return '0x0';
      return null;
    };
    const got = await readWalletFunds(read, route, owner);
    expect(got.asOf).toBe(new Date(1_700_000_000_000).toISOString());
    expect(got.token).toEqual({ known: true, units: 100_000_000n, amount: '100' });
    expect(got.gas).toEqual({ known: true, units: 0n, amount: '0' });
    expect(asked.filter(([m]) => m !== 'eth_getBlockByNumber').every(([, p]) => p[p.length - 1] === '0xa')).toBe(true);
  });

  it('is not known, never 0, when the chain does not answer', async () => {
    const got = await readWalletFunds(
      async (m) => (m === 'eth_getBlockByNumber' ? { number: '0x1', timestamp: '0x1' } : null),
      route,
      owner,
    );
    expect(got.token).toEqual({ known: false });
    expect(got.gas).toEqual({ known: false });
    const none = await readWalletFunds(async () => Promise.reject(new Error('down')), route, owner);
    expect(none).toEqual({ asOf: null, block: null, token: { known: false }, gas: { known: false } });
  });
});

describe('checkDeposit', () => {
  const check = (amount: string, f = funds(100_000_000n, 10n ** 18n), r = route) => checkDeposit({ amount, route: r, funds: f, fee });

  it('passes a deposit the wallet can pay, at or above the minimum', () => {
    expect(check('5')).toEqual({ ok: true, units: 5_000_000n });
    expect(check('12.5')).toEqual({ ok: true, units: 12_500_000n });
  });

  it('refuses an amount that is not a positive amount in the token decimals', () => {
    for (const amount of ['', '0', '-1', '1.1234567', 'abc']) expect(check(amount)).toEqual({ ok: false, stop: { kind: 'amount' } });
  });

  it('refuses below the venue minimum, naming it, before looking at balances', () => {
    expect(check('4.999999', funds(null, null))).toEqual({ ok: false, stop: { kind: 'below_minimum', minimum: '5' } });
    expect(check('1', funds(100_000_000n, 10n ** 18n), { ...route, minimum: null })).toEqual({ ok: true, units: 1_000_000n });
  });

  it('stops with no gas, carrying the fee estimate, before signing', () => {
    expect(check('10', funds(100_000_000n, 0n))).toEqual({ ok: false, stop: { kind: 'no_gas', fee } });
    expect(check('10', funds(100_000_000n, 20_999n))).toEqual({
      ok: false,
      stop: { kind: 'gas_short', fee, balance: '20999' },
    });
  });

  it('stops when a balance is not known or too small', () => {
    expect(check('10', funds(null, 1n))).toEqual({ ok: false, stop: { kind: 'balance_unknown' } });
    expect(check('10', funds(100_000_000n, null))).toEqual({ ok: false, stop: { kind: 'balance_unknown' } });
    expect(check('101', funds(100_000_000n, 10n ** 18n))).toEqual({ ok: false, stop: { kind: 'not_enough', balance: '100000000' } });
  });
});

describe('the transaction and the chain receipts', () => {
  it('is one ERC-20 transfer to the venue bridge, at the given nonce', () => {
    const tx = depositTransaction(route, owner, 5_000_000n, 3);
    expect(tx).toEqual({
      chainId: 84532,
      to: route.token,
      value: '0x0',
      nonce: 3,
      data: `0xa9059cbb${route.address.slice(2).padStart(64, '0')}${5_000_000n.toString(16).padStart(64, '0')}`,
    });
  });

  it('estimates the fee as gas times price, or not known', async () => {
    const read: ChainRead = async (m) => (m === 'eth_estimateGas' ? hex(50_000n) : hex(2n));
    expect(await estimateNetworkFee(read, route, owner, 1n)).toMatchObject({ known: true, units: 100_000n });
    expect(await estimateNetworkFee(async () => null, route, owner, 1n)).toEqual({ known: false });
  });

  it('reads the pending nonce, and the fee the chain charged once mined', async () => {
    expect(await readNonce(async () => '0x4', owner)).toBe(4);
    expect(await readNonce(async () => Promise.reject(new Error('x')), owner)).toBeNull();
    expect(await paidNetworkFee(async () => null, '0xabc', 84532)).toBeNull();
    const mined = await paidNetworkFee(async () => ({ status: '0x1', gasUsed: hex(40_000n), effectiveGasPrice: hex(3n) }), '0xabc', 84532);
    expect(mined).toMatchObject({ status: 'mined', fee: { known: true, units: 120_000n } });
    expect(await paidNetworkFee(async () => ({ status: '0x0' }), '0xabc', 84532)).toEqual({ status: 'reverted', fee: { known: false } });
  });
});

describe('assetWay', () => {
  const routes = [
    { asset: 'USDC', network: 'TEST chain', how: 'bridge' },
    { asset: 'TESTBTC', network: 'TEST bitcoin', how: 'Send to your TEST bitcoin deposit address.' },
    { asset: 'TESTDOGE', network: null, how: null },
  ];
  it('names the bridge, another published route, or not offered', () => {
    expect(assetWay('USDC', route, routes)).toEqual({ kind: 'bridge' });
    expect(assetWay('TESTBTC', route, routes)).toEqual({
      kind: 'other_route',
      network: 'TEST bitcoin',
      how: 'Send to your TEST bitcoin deposit address.',
    });
    expect(assetWay('TESTDOGE', route, routes)).toEqual({ kind: 'not_offered' });
    expect(assetWay('UNLISTED', route, routes)).toEqual({ kind: 'not_offered' });
  });
});
