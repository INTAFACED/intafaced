import { describe, expect, it } from 'vitest';
import { assertPasswordNotIdentity, WeakPasswordError } from './passwords.js';

describe('assertPasswordNotIdentity (I-signin-sessions-04)', () => {
  it('refuses the handle, the email and its local part, ignoring case and spaces', () => {
    const identity = { handle: 'NinoTrader2026', email: 'nino.trader@example.com' };
    for (const pw of ['ninotrader2026', ' NINO.TRADER@EXAMPLE.COM ', 'nino.trader']) {
      expect(() => assertPasswordNotIdentity(pw, identity)).toThrow(WeakPasswordError);
    }
  });

  it('allows a password that only contains a name, and ignores blank or missing names', () => {
    expect(() => assertPasswordNotIdentity('ninotrader2026 and more', { handle: 'ninotrader2026', email: 'a@b.c' })).not.toThrow();
    expect(() => assertPasswordNotIdentity('a long passphrase', { handle: '', email: null })).not.toThrow();
    expect(() => assertPasswordNotIdentity('noatsignaddress', { email: 'noatsignaddress' })).toThrow(WeakPasswordError);
  });
});
