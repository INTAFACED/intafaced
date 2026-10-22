import { describe, expect, it } from 'vitest';
import * as accounts from './accounts.js';

const SPACE = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

type Builder = (...args: string[]) => unknown;
const mod = accounts as unknown as Record<string, Builder | undefined>;

describe('business-owned earn pot (sub-account stake)', () => {
  it('subAccountEarnStakeAccount builds a subaccount stake keyed to the position', () => {
    const fn = mod.subAccountEarnStakeAccount;
    expect(typeof fn).toBe('function');
    expect(fn!(SPACE, 'USD', 'pos-1')).toEqual({
      ownerType: 'subaccount',
      ownerId: SPACE,
      assetId: 'USD',
      kind: 'stake',
      purpose: 'bank:earn:pos-1',
    });
  });

  it('two positions on one space never share a pot', () => {
    const fn = mod.subAccountEarnStakeAccount!;
    expect(fn(SPACE, 'USD', 'a')).not.toEqual(fn(SPACE, 'USD', 'b'));
  });

  it('a business earn pot is not the user earn pot for the same id', () => {
    const biz = mod.subAccountEarnStakeAccount!(SPACE, 'USD', 'p');
    expect(biz).not.toEqual(accounts.earnStakeAccount(SPACE, 'USD', 'p'));
  });

  it('subAccountStake refuses an empty or blank purpose', () => {
    const fn = mod.subAccountStake;
    expect(typeof fn).toBe('function');
    expect(() => fn!(SPACE, 'USD', '')).toThrow(/requires a purpose/);
    expect(() => fn!(SPACE, 'USD', '   ')).toThrow(/requires a purpose/);
  });

  it('subAccountStake trims the purpose', () => {
    expect(mod.subAccountStake!(SPACE, 'USD', '  bank:earn:x  ')).toMatchObject({ purpose: 'bank:earn:x' });
  });

  it('the user earn path is unchanged', () => {
    expect(accounts.earnStakeAccount(USER, 'USD', 'pos-1')).toEqual({
      ownerType: 'user',
      ownerId: USER,
      assetId: 'USD',
      kind: 'stake',
      purpose: 'bank:earn:pos-1',
    });
  });
});
