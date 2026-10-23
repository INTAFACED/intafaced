import { describe, expect, it } from 'vitest';
import { mergePartnerSettings } from './partner-settings';

const BUILD = 'https://build.example.test';

describe('mergePartnerSettings', () => {
  it("links the founders' join address once they have set one", () => {
    expect(mergePartnerSettings({ ok: true, joinUrl: 'https://join.example.test', partnerTerms: null, revision: 1 }, BUILD)).toEqual({
      status: 'ready',
      formHref: 'https://join.example.test/partner',
      terms: null,
    });
  });

  it('has no form link when the founders cleared the join address, even with a build address', () => {
    expect(mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: 'TEST terms', revision: 2 }, BUILD)).toEqual({
      status: 'ready',
      formHref: null,
      terms: 'TEST terms',
    });
  });

  it('uses the build address before the founders have set anything, or when the desk could not be read', () => {
    expect(mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: null, revision: 0 }, BUILD).formHref).toBe(`${BUILD}/partner`);
    expect(mergePartnerSettings({ ok: false }, BUILD)).toEqual({ status: 'unread', formHref: `${BUILD}/partner`, terms: null });
  });

  it('has no form link when neither address is usable', () => {
    expect(mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: null, revision: 0 }, undefined).formHref).toBeNull();
    expect(
      mergePartnerSettings({ ok: true, joinUrl: null, partnerTerms: null, revision: 0 }, 'http://join.example.test').formHref,
    ).toBeNull();
  });
});
