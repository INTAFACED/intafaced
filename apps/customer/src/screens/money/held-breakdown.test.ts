import { describe, expect, it } from 'vitest';
import { dec } from '../../data/decimal';
import { allAdd, heldFor, spacesFor } from './held-breakdown';
import type { NamedAccount } from './portfolio-source';

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

  it('an Amount worked out on this device leaves spaces out, so In spaces is 0 there', () => {
    const spaces = spacesFor(ready([space('a', 'USDT', '470')]), 'derived');
    expect(spaces.state).toBe('not-in-amount');
    expect(heldFor('USDT', '554.62', balance, spaces)).toMatchObject({ inSpaces: '0', adds: true });
  });
});
