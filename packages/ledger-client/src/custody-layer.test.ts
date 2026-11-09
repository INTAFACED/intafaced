import { describe, expect, it } from 'vitest';
import {
  earnStakeAccount,
  houseFees,
  insuranceFund,
  merchantClearing,
  merchantProceeds,
  orderHoldAccount,
  railBoundary,
  rewardsEngine,
  subAccountAvailable,
  userAvailable,
} from './accounts.js';
import { isCustomerBalanceAccount, movesCustomerBalance, parseCustodyLayer } from './custody-layer.js';
import { recipes } from './recipes/index.js';
import { parseAmount } from './money.js';

const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('isCustomerBalanceAccount (the custody switch, OWNER 226)', () => {
  it.each([
    ['user available', userAvailable(U, 'USDT')],
    ['user order hold', orderHoldAccount(U, 'USDT', 'o1')],
    ['user earn stake', earnStakeAccount(U, 'USDT', 'p1')],
    ['sub-account available', subAccountAvailable(S, 'USDT')],
    ['merchant clearing', merchantClearing('m1', 'USDT')],
    ['merchant proceeds', merchantProceeds('m1', 'USDT')],
  ])('%s is a customer balance', (_name, ref) => {
    expect(isCustomerBalanceAccount(ref)).toBe(true);
  });

  it.each([
    ['house fees', houseFees('trade', 'USDT')],
    ['insurance fund', insuranceFund('USDT')],
    ['rewards engine', rewardsEngine('USDT')],
    ['rail boundary', railBoundary('test', 'USDT')],
  ])('%s is INTAFACED own pot', (_name, ref) => {
    expect(isCustomerBalanceAccount(ref)).toBe(false);
  });

  it('flags a deposit and not a fee sweep', () => {
    const amount = parseAmount('1');
    expect(movesCustomerBalance(recipes.deposit({ userId: U, assetId: 'USDT', amount, rail: 'test', railRef: 'r1' }).entries)).toBe(true);
    expect(
      movesCustomerBalance(recipes.sweepFeesToRewards({ windowId: 'w1', sourceModule: 'trade', assetId: 'USDT', amount }).entries),
    ).toBe(false);
  });
});

describe('parseCustodyLayer', () => {
  it('reads unset and blank as off, the launch decision', () => {
    expect(parseCustodyLayer(undefined)).toBe('off');
    expect(parseCustodyLayer('')).toBe('off');
    expect(parseCustodyLayer('  ')).toBe('off');
  });
  it('reads on and off, any case', () => {
    expect(parseCustodyLayer(' ON ')).toBe('on');
    expect(parseCustodyLayer('off')).toBe('off');
  });
  it.each(['true', '1', 'of'])('throws on %j rather than guess', (v) => {
    expect(() => parseCustodyLayer(v)).toThrow(/LEDGER_CUSTODY_LAYER/);
  });
});
