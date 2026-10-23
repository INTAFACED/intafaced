import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { WalletPay, failClosedWalletPublish, railRetryWhileRequested, supportLabel } from './wallet-pay.js';

const USER = '11111111-1111-4111-8111-111111111111';

function gate(publish = failClosedWalletPublish()) {
  return new WalletPay({
    publish,
    allowlist: { has: () => false },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    openHolds: async () => 0n,
  });
}

describe('WAL-0163 a requested attempt is not asked again', () => {
  it('treats requested as unknown and every other outcome as safe to ask', () => {
    expect(railRetryWhileRequested('requested')).toBe('unknown');
    expect(railRetryWhileRequested('accepted')).toBe('ask');
    expect(railRetryWhileRequested('refused')).toBe('ask');
    expect(railRetryWhileRequested(undefined)).toBe('ask');
  });
});

describe('SUP-0012 support labels an accepted send irreversible', () => {
  it('stays unknown unless the chain reader confirms the stored hash', async () => {
    expect(await supportLabel([{ outcome: 'requested', railRef: null }], { confirm: async () => 'confirmed' })).toBe('unknown');
    expect(await supportLabel([{ outcome: 'accepted', railRef: '0xabc' }], { confirm: async () => 'down' })).toBe('unknown');
    expect(await supportLabel([{ outcome: 'accepted', railRef: '0xabc' }], { confirm: async () => 'confirmed' })).toBe('irreversible');
  });
});

describe('WAL-0079 estimateFee posts nothing', () => {
  it('refuses a blank published fee', async () => {
    await expect(gate().estimateFee({ assetId: 'USDT', chain: 'ETH', address: '0xabc' })).rejects.toMatchObject({
      code: 'pay.wallet_fee_unset',
    });
  });

  it('returns the published fee and does not mark anything sent', async () => {
    const wallet = gate({
      ...failClosedWalletPublish('live'),
      networkFee: () => '0.25',
    });
    await expect(wallet.estimateFee({ assetId: 'USDT', chain: 'ETH', address: '0xabc' })).resolves.toEqual({
      fee: '0.25',
      assetId: 'USDT',
      address: '0xabc',
      sent: false,
    });
  });
});

describe('WAL-0186 a blocked withdraw feature refuses before a hold', () => {
  it('refuses a fresh withdrawal while the published status is blocked', async () => {
    await expect(
      gate().assertCustomerWithdrawal({
        userId: USER,
        assetId: 'USDT',
        network: 'card-sandbox',
        amount: parseAmount('1'),
        clientRef: 'w-1',
        typedAddress: 'DE89370400440532013000',
      }),
    ).rejects.toMatchObject({ code: 'pay.wallet_withdraw_unavailable' });
  });
});
