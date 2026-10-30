import { describe, expect, it } from 'vitest';
import type { Destination } from './contracts';
import { WALLET_NOT_CONNECTED, asksForWallet, walletFill, walletGone, walletSavedNetwork } from './withdraw-to-wallet';

const WALLET = '0x52908400098527886e0f7030069857d2e4169ee7';
const OFFERED = [{ networkId: 'ethereum' }, { networkId: 'base' }];
const row = (over: Partial<Destination> = {}): Destination => ({
  destinationId: '22222222-2222-4222-8222-222222222222',
  label: 'TEST wallet',
  kind: 'crypto',
  ref: '0x52908400098527886E0F7030069857D2E4169EE7',
  addedAt: '2026-10-01T10:00:00Z',
  coolingOffEndsAt: '2026-10-02T10:00:00Z',
  coolingBlocker: null,
  assetId: 'USDT',
  network: 'base',
  state: 'active',
  ...over,
});

describe('asksForWallet: the address bar asks for the wallet fill with exactly one to=wallet', () => {
  it('reads to=wallet and nothing else', () => {
    expect(asksForWallet('?to=wallet')).toBe(true);
    expect(asksForWallet('?asset=USDT&to=wallet')).toBe(true);
    for (const search of ['', '?to=Wallet', '?to=', '?to=wallet&to=wallet', '?to=bank', '?wallet'])
      expect(asksForWallet(search), search).toBe(false);
  });
});

describe('walletFill: the destination comes from the connected account only', () => {
  it('is off when not asked, whatever the wallet holds', () => {
    expect(walletFill(false, { status: 'connected', address: WALLET, chainId: 84532 })).toEqual({ state: 'off' });
  });
  it('fills the connected account exactly as the wallet gave it, with the chain it reports', () => {
    expect(walletFill(true, { status: 'connected', address: WALLET, chainId: 84532 })).toEqual({
      state: 'filled',
      address: WALLET,
      chainId: 84532,
    });
    expect(walletFill(true, { status: 'connected', address: WALLET, chainId: null })).toMatchObject({ state: 'filled', chainId: null });
  });
  it('fills nothing with no wallet, or an account that is not a 0x address, and names wallet.not_connected', () => {
    const none = { state: 'none', code: WALLET_NOT_CONNECTED };
    expect(walletFill(true, { status: 'disconnected', address: null, chainId: null })).toEqual(none);
    expect(walletFill(true, { status: 'connected', address: null, chainId: 84532 })).toEqual(none);
    expect(walletFill(true, { status: 'connected', address: '0x1234', chainId: 84532 })).toEqual(none);
    expect(walletFill(true, { status: 'connected', address: `${WALLET} `, chainId: 84532 })).toEqual(none);
    expect(WALLET_NOT_CONNECTED).toBe('wallet.not_connected');
  });
  it('is checking while the wallet is asked', () => {
    expect(walletFill(true, { status: 'connecting', address: null, chainId: null })).toEqual({ state: 'checking' });
  });
});

describe('walletSavedNetwork: the network comes from the person’s own saved entry, never from the wallet’s chain', () => {
  it('is the one network this address is saved on for the asset, matched without case', () => {
    expect(walletSavedNetwork([row()], 'USDT', WALLET, OFFERED)).toBe('base');
    expect(walletSavedNetwork([row({ state: 'cooling' }), row({ destinationId: 'x' })], 'USDT', WALLET, OFFERED)).toBe('base');
  });
  it('is nothing with no saved entry, another asset, a bank entry, or only archived ones', () => {
    expect(walletSavedNetwork([], 'USDT', WALLET, OFFERED)).toBeNull();
    expect(walletSavedNetwork([row({ assetId: 'USDC' })], 'USDT', WALLET, OFFERED)).toBeNull();
    expect(walletSavedNetwork([row({ kind: 'bank' })], 'USDT', WALLET, OFFERED)).toBeNull();
    expect(walletSavedNetwork([row({ state: 'archived' })], 'USDT', WALLET, OFFERED)).toBeNull();
    expect(walletSavedNetwork([row({ ref: '0x0000000000000000000000000000000000000001' })], 'USDT', WALLET, OFFERED)).toBeNull();
  });
  it('is nothing when the address is saved on two networks: the person chooses', () => {
    expect(walletSavedNetwork([row(), row({ destinationId: 'y', network: 'ethereum' })], 'USDT', WALLET, OFFERED)).toBeNull();
  });
  it('is nothing when the saved network is not one the asset list opens, or the entry names none', () => {
    expect(walletSavedNetwork([row()], 'USDT', WALLET, [{ networkId: 'ethereum' }])).toBeNull();
    expect(walletSavedNetwork([row({ network: null })], 'USDT', WALLET, OFFERED)).toBeNull();
  });
});

describe('walletGone: a fill that was in use goes when the wallet disconnects or switches account', () => {
  const filled = { state: 'filled', address: WALLET, chainId: 84532 } as const;
  it('is gone on disconnect or another account', () => {
    expect(walletGone(filled, { state: 'none', code: WALLET_NOT_CONNECTED })).toBe(true);
    expect(walletGone(filled, { ...filled, address: '0x0000000000000000000000000000000000000001' })).toBe(true);
  });
  it('is not gone for the same account (any case), a chain switch, or a fill that never held an address', () => {
    expect(walletGone(filled, { ...filled, address: WALLET.toUpperCase().replace('0X', '0x') })).toBe(false);
    expect(walletGone(filled, { ...filled, chainId: 1 })).toBe(false);
    expect(walletGone({ state: 'none', code: WALLET_NOT_CONNECTED }, { state: 'none', code: WALLET_NOT_CONNECTED })).toBe(false);
    expect(walletGone({ state: 'off' }, filled)).toBe(false);
  });
});
