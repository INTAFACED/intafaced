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

  it('needs at least one setting, and null clears one', () => {
    expect(set({}).success).toBe(false);
    expect(set({ partnerTerms: null }).success).toBe(true);
  });
});
