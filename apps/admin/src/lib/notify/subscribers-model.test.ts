import { describe, expect, it } from 'vitest';
import { addressesIn, importPreview, readChannels, readImportResult, safeguardValue } from './subscribers-model';

describe('subscriber desk model', () => {
  it('reads pasted addresses one per line or by commas, and previews duplicates in any case as one', () => {
    expect(addressesIn(' a@example.com\nA@example.com, b@example.com;\n\n')).toEqual(['a@example.com', 'A@example.com', 'b@example.com']);
    expect(importPreview('a@example.com\nA@example.com')).toEqual({ lines: 2, distinct: 1 });
    expect(importPreview('')).toEqual({ lines: 0, distinct: 0 });
  });

  it('a safeguard left blank is blank, never a default; out of bounds is refused', () => {
    expect(safeguardValue(' ', 1, 32)).toEqual({ ok: true, value: null });
    expect(safeguardValue('12', 1, 32)).toEqual({ ok: true, value: 12 });
    expect(safeguardValue('0', 1, 32)).toEqual({ ok: false });
    expect(safeguardValue('1.5', 1, 32)).toEqual({ ok: false });
  });

  it('refuses shapes it cannot read', () => {
    expect(readChannels({ email: { sender: 'smtp', notConnected: null }, sms: 'vendor.sms', push: 'vendor.push' })).toBeNull();
    expect(readChannels({ email: { sender: null, notConnected: 'vendor.email' }, sms: 'vendor.sms', push: 'vendor.push' })).not.toBeNull();
    expect(readImportResult({ received: 1, distinct: 1, added: 1, alreadyKnown: 0, invalid: [1], limited: 0 })).toBeNull();
  });
});
