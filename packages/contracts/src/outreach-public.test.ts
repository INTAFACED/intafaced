import { describe, expect, it } from 'vitest';
import { outreachPublicProblem, outreachPublicSettingsSetInputSchema } from './outreach-public.js';

const set = (fields: Record<string, unknown>) =>
  outreachPublicSettingsSetInputSchema.safeParse({ expectedRevision: 0, reason: 'TEST', ...fields });

describe('outreach public settings', () => {
  it('takes a join address as an https origin, or http on this machine, and stores it without a trailing slash', () => {
    expect(outreachPublicProblem('joinUrl', 'https://join.example.test')).toBeNull();
    expect(outreachPublicProblem('joinUrl', 'http://127.0.0.1:3220')).toBeNull();
    for (const input of [' https://join.example.test/ ', 'https://Join.Example.test', 'https://join.example.test:443']) {
      const parsed = set({ joinUrl: input });
      expect(parsed.success && parsed.data.joinUrl, input).toBe('https://join.example.test');
    }
  });

  it('refuses a join address that is not a bare https origin', () => {
    expect(outreachPublicProblem('joinUrl', 'http://join.example.test')).toBe('not_https');
    expect(outreachPublicProblem('joinUrl', 'https://join.example.test/partner')).toBe('not_an_origin');
    expect(outreachPublicProblem('joinUrl', 'https://join.example.test?x=1')).toBe('not_an_origin');
    expect(outreachPublicProblem('joinUrl', 'https://join.example.test#top')).toBe('not_an_origin');
    expect(outreachPublicProblem('joinUrl', 'https://user:pw@join.example.test')).toBe('not_an_origin');
    expect(outreachPublicProblem('joinUrl', 'javascript:alert(1)')).not.toBeNull();
    expect(set({ joinUrl: 'join.example.test' }).success).toBe(false);
  });

  it('takes terms as plain text with line breaks, and refuses control characters', () => {
    expect(outreachPublicProblem('partnerTerms', 'TEST terms\nsecond line')).toBeNull();
    expect(outreachPublicProblem('partnerTerms', 'TEST\u0000terms')).toBe('not_text');
    expect(outreachPublicProblem('partnerTerms', 'TEST\u2028terms')).toBe('not_text');
    expect(outreachPublicProblem('partnerTerms', 'TEST\u202Eterms')).toBe('not_text');
    // Joiners and direction marks are part of real text (Persian, Arabic, emoji sequences).
    expect(outreachPublicProblem('partnerTerms', 'TEST\u200Cterms\u200E \u{1F469}\u200D\u{1F4BB}')).toBeNull();
    expect(outreachPublicProblem('partnerTerms', 'x'.repeat(20_001))).toBe('too_long');
  });

  it('takes a store link as a whole https link, kept exactly as written once trimmed', () => {
    expect(outreachPublicProblem('appStoreUrl', 'https://apps.apple.com/app/id0000000000')).toBeNull();
    expect(outreachPublicProblem('appStoreUrl', 'https://play.google.com/store/apps/details?id=test.app')).toBeNull();
    const parsed = set({ appStoreUrl: ' https://apps.apple.com/app/id0000000000 ' });
    expect(parsed.success && parsed.data.appStoreUrl).toBe('https://apps.apple.com/app/id0000000000');
  });

  it('refuses a store link that is not https, carries a user or password, or is not a link', () => {
    expect(outreachPublicProblem('appStoreUrl', 'http://apps.apple.com/app/id0000000000')).toBe('not_https');
    expect(outreachPublicProblem('appStoreUrl', 'http://127.0.0.1:3220/app')).toBe('not_https');
    expect(outreachPublicProblem('appStoreUrl', 'javascript:alert(1)')).not.toBeNull();
    expect(outreachPublicProblem('appStoreUrl', 'https://user:pw@apps.apple.com/app')).toBe('not_a_link');
    expect(outreachPublicProblem('appStoreUrl', 'apps.apple.com/app')).toBe('not_a_link');
    expect(outreachPublicProblem('appStoreUrl', `https://apps.apple.com/${'x'.repeat(300)}`)).toBe('too_long');
    expect(set({ appStoreUrl: 'http://apps.apple.com/app' }).success).toBe(false);
  });

  it('needs at least one setting, and null clears one', () => {
    expect(set({}).success).toBe(false);
    expect(set({ partnerTerms: null }).success).toBe(true);
  });
});
