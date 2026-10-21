import { describe, expect, it } from 'vitest';
import { depositHref, readDepositLink, resolveDepositLink } from './deposit-link';
import type { DepositCatalogue } from './deposit-reads';

// TEST figures, not published settings.
const catalogue: DepositCatalogue = {
  assets: [
    {
      assetId: 'USDT',
      networks: [
        { id: 'ethereum', label: 'Ethereum', minimumDeposit: '10', confirmationsRequired: 12, estimatedArrivalMinutes: 5 },
        { id: 'tron', label: 'Tron', minimumDeposit: '5.5', confirmationsRequired: 20, estimatedArrivalMinutes: 3 },
      ],
    },
    { assetId: 'BTC', networks: [] },
  ],
};

describe('deposit address link', () => {
  it('reads the asset and the network, and leaves out what is missing or blank', () => {
    expect(readDepositLink('?asset=USDT&network=tron')).toEqual({ asset: 'USDT', network: 'tron' });
    expect(readDepositLink('?asset=%20&network=')).toEqual({ asset: null, network: null });
    expect(readDepositLink('')).toEqual({ asset: null, network: null });
    expect(readDepositLink(`?asset=${'A'.repeat(500)}`).asset).toHaveLength(64);
  });

  it('builds the address from an asset and a network, and a network alone is dropped', () => {
    expect(depositHref()).toBe('/uc/recharge');
    expect(depositHref('USDT')).toBe('/uc/recharge?asset=USDT');
    expect(depositHref('USDT', 'tron')).toBe('/uc/recharge?asset=USDT&network=tron');
    expect(depositHref(null, 'tron')).toBe('/uc/recharge');
    expect(readDepositLink(depositHref('A&B', 'x y').slice(depositHref('A&B', 'x y').indexOf('?')))).toEqual({
      asset: 'A&B',
      network: 'x y',
    });
  });

  it('picks the published asset and network, ignoring case, and returns the published spelling', () => {
    expect(resolveDepositLink({ asset: 'usdt', network: 'TRON' }, catalogue)).toEqual({ status: 'ok', asset: 'USDT', network: 'tron' });
    expect(resolveDepositLink({ asset: 'USDT', network: null }, catalogue)).toEqual({ status: 'ok', asset: 'USDT', network: '' });
  });

  it('refuses an asset or a network that is not published, by typed code, and chooses nothing', () => {
    expect(resolveDepositLink({ asset: 'DOGE', network: null }, catalogue)).toEqual({
      status: 'refused',
      code: 'bank.deposit_asset_unpublished',
      asset: 'DOGE',
      network: null,
    });
    expect(resolveDepositLink({ asset: 'USDT', network: 'solana' }, catalogue)).toMatchObject({
      status: 'refused',
      code: 'bank.deposit_network_unpublished',
      asset: 'USDT',
      network: 'solana',
    });
    expect(resolveDepositLink({ asset: 'BTC', network: 'bitcoin' }, catalogue)).toMatchObject({ code: 'bank.deposit_network_unpublished' });
  });

  it('does not judge a link without a published list, or without an asset', () => {
    expect(resolveDepositLink({ asset: 'USDT', network: 'tron' }, null)).toEqual({ status: 'none' });
    expect(resolveDepositLink({ asset: null, network: 'tron' }, catalogue)).toEqual({ status: 'none' });
  });
});
