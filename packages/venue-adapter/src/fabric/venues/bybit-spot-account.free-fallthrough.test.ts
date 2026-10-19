import { describe, expect, it } from 'vitest';
import { mapBybitSpotCoins } from './bybit-spot-account.js';
describe('L105 empty availableToWithdraw falls through', () => {
  it('uses free when availableToWithdraw is an empty string', () => {
    const [b] = mapBybitSpotCoins([{ coin: 'USDT', walletBalance: '10', locked: '0', availableToWithdraw: '', free: '4' }], new Date(0));
    expect(b!.free).toBe(4n * 10n ** 18n);
  });
});
