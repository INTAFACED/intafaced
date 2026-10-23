import { describe, expect, it } from 'vitest';
import { mergePartnerSettings } from './partner-settings';

describe('mergePartnerSettings', () => {
  it("prefers the founders' join address over the build address", () => {
    expect(
      mergePartnerSettings({ ok: true, joinUrl: 'https://join.example.test', partnerTerms: null }, 'https://build.example.test'),
    ).toEqual({
      status: 'ready',
      formHref: 'https://join.example.test/partner',
      terms: null,
    });
  });

  it('falls back to the build address when the desk holds none, or could not be read', () => {
    expect(mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: 'TEST terms' }, 'https://build.example.test')).toEqual({
      status: 'ready',
      formHref: 'https://build.example.test/partner',
      terms: 'TEST terms',
    });
    expect(mergePartnerSettings({ ok: false }, 'https://build.example.test')).toEqual({
      status: 'unread',
      formHref: 'https://build.example.test/partner',
      terms: null,
    });
  });

  it('has no form link when neither address is usable', () => {
    expect(mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: null }, undefined).formHref).toBeNull();
    expect(mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: null }, 'http://join.example.test').formHref).toBeNull();
  });
});
