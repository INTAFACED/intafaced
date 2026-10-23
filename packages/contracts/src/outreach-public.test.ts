import { describe, expect, it } from 'vitest';
import { outreachPublicProblem, outreachPublicSettingsSetInputSchema } from './outreach-public.js';

const set = (fields: Record<string, unknown>) =>
  outreachPublicSettingsSetInputSchema.safeParse({ expectedRevision: 0, reason: 'TEST', ...fields });

describe('outreach public settings', () => {
  it('takes a join address as an https origin, or http on this machine, and stores it without a trailing slash', () => {
    expect(outreachPublicProblem('joinUrl', 'https://join.example.test')).toBeNull();
    expect(outreachPublicProblem('joinUrl', 'http://127.0.0.1:3220')).toBeNull();
    const parsed = set({ joinUrl: ' https://join.example.test/ ' });
    expect(parsed.success && parsed.data.joinUrl).toBe('https://join.example.test');
  });

  it('refuses a join address that is not a bare https origin', () => {
    expect(outreachPublicProblem('joinUrl', 'http://join.example.test')).toBe('not_https');
    expect(outreachPublicProblem('joinUrl', 'https://join.example.test/partner')).toBe('not_an_origin');
    expect(outreachPublicProblem('joinUrl', 'https://user:pw@join.example.test')).toBe('not_an_origin');
    expect(outreachPublicProblem('joinUrl', 'javascript:alert(1)')).not.toBeNull();
    expect(set({ joinUrl: 'join.example.test' }).success).toBe(false);
  });

  it('takes terms as plain text with line breaks, and refuses control characters', () => {
    expect(outreachPublicProblem('partnerTerms', 'TEST terms\nsecond line')).toBeNull();
    expect(outreachPublicProblem('partnerTerms', 'TEST\u0000terms')).toBe('not_text');
    expect(outreachPublicProblem('partnerTerms', 'TEST terms')).toBe('not_text');
    expect(outreachPublicProblem('partnerTerms', 'x'.repeat(20_001))).toBe('too_long');
  });

  it('needs at least one setting, and null clears one', () => {
    expect(set({}).success).toBe(false);
    expect(set({ partnerTerms: null }).success).toBe(true);
  });
});
