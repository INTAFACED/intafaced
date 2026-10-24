import { describe, expect, it } from 'vitest';
import { cleanPhone, methodStepUp, signinMethods, walletMethod, waysIn } from './signin-methods';

const address = '0x00000000000000000000000000000000000000aa';

describe('ways to sign in (I-account-lifecycle-07)', () => {
  it('counts every way in, so the last one is known before anything is sent', () => {
    const methods = signinMethods.parse({
      password: true,
      emailCode: { on: false, address: 'a@example.test', proved: true },
      passkeys: 2,
      wallets: [{ address, linkedAt: '2026-10-24T16:00:00.000Z' }],
      providers: [],
    });
    expect(waysIn(methods)).toBe(4);
    expect(waysIn({ ...methods, password: false, passkeys: 0 })).toBe(1);
  });

  it('refuses a wallet address the service would not send', () => {
    expect(() =>
      signinMethods.parse({
        password: false,
        emailCode: { on: false, address: null, proved: false },
        passkeys: 0,
        wallets: [{ address: 'nope', linkedAt: '' }],
        providers: [],
      }),
    ).toThrow();
  });

  it('binds the step-up to the one method it changes', () => {
    expect(methodStepUp('unlink', walletMethod(address.toUpperCase().replace('0X', '0x')), 'req-1')).toEqual({
      scope: 'identity.step_up.unlink_method',
      purpose: 'account.signinMethod.unlink',
      target: `wallet_siwe:${address}`,
      fields: { method: `wallet_siwe:${address}`, clientRequestId: 'req-1' },
    });
    expect(methodStepUp('link', 'password', 'req-2').scope).toBe('identity.step_up.link_method');
  });

  it('takes a phone number only in international form', () => {
    expect(cleanPhone('+44 (20) 7946-0000')).toBe('+442079460000');
    expect(cleanPhone('020 7946 0000')).toBeNull();
    expect(cleanPhone('+0123456789')).toBeNull();
  });
});
