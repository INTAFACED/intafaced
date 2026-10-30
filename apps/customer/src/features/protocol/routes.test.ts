import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { isWeb3Path, matchWeb3Route, WEB3_ROUTES } from './routes';
import { lastShellRoute, rememberShellRoute, shellOf, SHELL_DEFAULT } from './shell-state';

describe('Web3 routes (IA-SPEC 2.8)', () => {
  it('has all thirty-one routes, each registered as a web3 room', () => {
    expect(WEB3_ROUTES.map((route) => route.path)).toEqual([
      '/dex',
      '/dex/pools',
      '/dex/pools/new',
      '/dex/pools/:poolId',
      '/dex/positions',
      '/dex/positions/:positionId',
      '/dex/tokens',
      '/dex/tokens/:address',
      '/dex/venue',
      '/wallet',
      '/wallet/activity',
      '/wallet/send',
      '/wallet/receive',
      '/wallet/scan',
      '/wallet/address-book',
      '/wallet/approvals',
      '/wallet/session-keys',
      '/wallet/accounts',
      '/wallet/safety',
      '/wallet/groups/:groupId',
      '/chain',
      '/chain/blocks',
      '/chain/blocks/:height',
      '/chain/tx/:hash',
      '/chain/address/:address',
      '/chain/watchlist',
      '/chain/validators',
      '/chain/validators/:validatorId',
      '/chain/audit',
      '/protocol',
      '/protocol/contracts',
      '/protocol/rails',
      '/protocol/audit',
    ]);
    for (const path of ['/dex', '/dex/pools/new', '/wallet', '/chain/blocks/123456', '/protocol/audit', '/dex/unknown/deep'])
      expect(findRoom(path)?.area, path).toBe('web3');
  });

  it('puts a specific route before the parameter route that could swallow it', () => {
    expect(matchWeb3Route('/dex/pools/new')?.route.pending?.page).toBe('poolNew');
    expect(matchWeb3Route('/dex/pools/abc')?.route.pending?.page).toBe('poolDetail');
    expect(matchWeb3Route('/dex/pools/')?.route.tab).toBe('pools');
    expect(matchWeb3Route('/chain/blocks/123456')?.params).toEqual({ height: '123456' });
  });

  it('knows nothing it was not given', () => {
    expect(matchWeb3Route('/dex/nothing/here')).toBeUndefined();
    expect(isWeb3Path('/dex/nothing/here')).toBe(true);
    expect(isWeb3Path('/dexterity')).toBe(false);
    expect(isWeb3Path('/trade/spot/BTC-USDT')).toBe(false);
  });
});

describe('Exchange | Web3 switch memory', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  it('returns to the last route of each shell and defaults when it has none', () => {
    const store = memory();
    expect(lastShellRoute('exchange', store)).toBe(SHELL_DEFAULT.exchange);
    rememberShellRoute('/trade/spot/ETH-USDT', store);
    rememberShellRoute('/dex/pools', store);
    expect(lastShellRoute('exchange', store)).toBe('/trade/spot/ETH-USDT');
    expect(lastShellRoute('web3', store)).toBe('/dex/pools');
    expect(shellOf('/chain/tx/0x1')).toBe('web3');
  });
  it('survives blocked storage and ignores a stored route from the other shell', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberShellRoute('/dex', blocked)).not.toThrow();
    expect(lastShellRoute('web3', blocked)).toBe('/dex');
    expect(lastShellRoute('exchange', { getItem: () => '/dex/pools' })).toBe('/');
    expect(lastShellRoute('exchange', { getItem: () => '//evil.example' })).toBe('/');
  });
});
