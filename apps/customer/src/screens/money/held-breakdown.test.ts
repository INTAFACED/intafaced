import { describe, expect, it } from 'vitest';
import { dec } from '../../data/decimal';
import { allAdd, heldFor, spacesFor } from './held-breakdown';
import { lockSplits, type NamedAccount } from './portfolio-source';

const space = (id: string, asset: string, balance: string): NamedAccount => ({ id, name: id, asset, balance });
const ready = (data: NamedAccount[]) => ({ status: 'ready', data, asOf: 1 }) as const;

// Illustrative test figures: 554.62 spendable or in orders plus 470 kept in two spaces = 1,024.62 held.
const balance = { free: '500.12', used: '54.5', total: '554.62' };

describe('Pro Money columns add up to Amount', () => {
  it('Available + In orders + In spaces equals Amount when spaces hold the rest', () => {
    const spaces = spacesFor(ready([space('a', 'USDT', '300'), space('b', 'USDT', '170'), space('c', 'BTC', '0.5')]), 'server');
    const held = heldFor('USDT', '1024.62', balance, spaces);
    expect(held.inSpaces).toBe('470');
    expect(held.adds).toBe(true);
    const sum = dec(held.available)! + dec(held.inOrders)! + dec(held.inSpaces)!;
    expect(sum).toBe(dec('1024.62'));
  });

  it('a coin with no named space shows 0 in spaces and still adds up', () => {
    const spaces = spacesFor(ready([space('a', 'USDT', '470')]), 'server');
    const held = heldFor('BTC', '0.1', { free: '0.1', used: '0', total: '0.1' }, spaces);
    expect(held).toMatchObject({ inSpaces: '0', adds: true });
  });

  it('no spaces at all is a known zero, not a gap', () => {
    const held = heldFor('USDT', '554.62', balance, spacesFor({ status: 'empty' }, 'server'));
    expect(held).toMatchObject({ inSpaces: '0', adds: true });
  });

  it('says so, with no figure, when the spaces list was not returned', () => {
    for (const snap of [{ status: 'loading' }, { status: 'error', retry: () => {} }] as const) {
      const spaces = spacesFor(snap as never, 'server');
      const held = heldFor('USDT', '1024.62', balance, spaces);
      expect(held.inSpaces).toBeNull();
      expect(held.adds).toBeNull();
    }
    expect(spacesFor({ status: 'error', retry: () => {} } as never, 'server').state).toBe('unavailable');
    expect(spacesFor({ status: 'loading' }, 'server').state).toBe('waiting');
  });

  it('one unreadable space balance counts as not returned, never as zero', () => {
    const spaces = spacesFor(ready([space('a', 'USDT', '100'), space('b', 'USDT', 'oops')]), 'server');
    expect(spaces.state).toBe('unavailable');
    expect(heldFor('USDT', '1024.62', balance, spaces).inSpaces).toBeNull();
  });

  it('flags a row that does not add up instead of hiding it', () => {
    const spaces = spacesFor(ready([space('a', 'USDT', '400')]), 'server');
    const held = heldFor('USDT', '1024.62', balance, spaces);
    expect(held.adds).toBe(false);
    expect(allAdd([held])).toBe(false);
  });

  it('missing balance figures give no sum', () => {
    const held = heldFor('USDT', '1024.62', undefined, spacesFor({ status: 'empty' }, 'server'));
    expect(held).toMatchObject({ available: null, inOrders: null, inSpaces: '0', adds: null });
    expect(allAdd([held])).toBeNull();
  });

  it('an Amount worked out on this device leaves spaces out: no spaces figure, and Available + In orders = Amount', () => {
    const spaces = spacesFor(ready([space('a', 'USDT', '470')]), 'derived');
    expect(spaces.state).toBe('not-in-amount');
    expect(heldFor('USDT', '554.62', balance, spaces)).toMatchObject({ inSpaces: null, adds: true });
    expect(heldFor('USDT', '1024.62', balance, spaces)).toMatchObject({ inSpaces: null, adds: false });
  });
});

describe('Pro Money tells locks apart from open orders', () => {
  // Illustrative test figures: 100 spendable, 30 in open orders, 20 staked, 10 collateral; 160 in the main account.
  const answer = {
    assets: [
      {
        assetId: 'USDT',
        total: '160',
        available: '100',
        locked: [
          { kind: 'hold', amount: '30', claims: [{ purpose: 'order:o-1', amount: '30' }] },
          { kind: 'stake', amount: '20', claims: [{ purpose: 'token:stake:s-1', amount: '20' }] },
          { kind: 'collateral', amount: '10', claims: [{ purpose: 'loan:l-1', amount: '10' }] },
        ],
      },
    ],
  };
  const noSpaces = spacesFor({ status: 'empty' }, 'server');

  it('In orders is the order holds only, Locked is everything else locked, and the four columns add up to Amount', () => {
    const locks = lockSplits(answer)!;
    // The exchange balance folds all three locks into used = 60; that is the figure the old column showed as "In orders".
    const held = heldFor('USDT', '160', { free: '100', used: '60', total: '160' }, noSpaces, locks);
    expect(held).toMatchObject({ available: '100', inOrders: '30', locked: '30', inSpaces: '0', adds: true });
    expect(held.claims.map((claim) => claim.purpose)).toEqual(['order:o-1', 'token:stake:s-1', 'loan:l-1']);
  });

  it('a coin missing from a breakdown that arrived has nothing locked, and the row still adds up', () => {
    const held = heldFor('BTC', '0', undefined, noSpaces, lockSplits(answer)!);
    expect(held).toMatchObject({ available: '0', inOrders: '0', locked: '0', adds: true });
  });

  it('without the breakdown the old single figure stays, and Locked is a dash rather than an invented zero', () => {
    const held = heldFor('USDT', '160', { free: '100', used: '60', total: '160' }, noSpaces);
    expect(held).toMatchObject({ available: '100', inOrders: '60', locked: null, claims: [], adds: true });
  });

  it('one amount that does not parse makes the whole breakdown unusable, never a shown zero', () => {
    const broken = { assets: [{ ...answer.assets[0]!, locked: [{ kind: 'hold', amount: 'oops', claims: [] }] }] };
    expect(lockSplits(broken)).toBeNull();
    expect(lockSplits({ assets: [{ ...answer.assets[0]!, available: '1e9' }] })).toBeNull();
  });

  it('a row whose parts do not add up is flagged, not forced to add', () => {
    const held = heldFor('USDT', '161', { free: '100', used: '60', total: '160' }, noSpaces, lockSplits(answer)!);
    expect(held.adds).toBe(false);
  });
});
