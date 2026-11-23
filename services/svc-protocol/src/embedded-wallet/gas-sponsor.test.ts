import { describe, expect, it } from 'vitest';
import { gasSponsorFromSetting } from './gas-sponsor.js';

describe('the gas-sponsor setting (J-wallet-24 #2)', () => {
  it('blank or absent is unset: no sponsored deposit, wallet.gas_sponsor_unset', () => {
    for (const raw of [undefined, '', '   ']) expect(gasSponsorFromSetting(raw)).toEqual({ set: false, code: 'wallet.gas_sponsor_unset' });
  });
  it("any value refuses to boot: this build pays no one's network fee", () => {
    expect(() => gasSponsorFromSetting('paymaster')).toThrow(/PROTOCOL_GAS_SPONSOR=.*Refusing to boot/);
  });
});
