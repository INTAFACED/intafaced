import { describe, expect, it } from 'vitest';
import { apiKeysCopy, scopeWords } from './api-keys-copy';

const t = apiKeysCopy.forLocale('en').t;
// The platform's scopes as packages/auth/src/scopes.ts lists them today (the customer app does not depend on that package).
const SCOPES = [
  'identity:read',
  'identity:write',
  'ledger:read',
  'trade:read',
  'trade:write',
  'trade:withdraw',
  'copy:lead',
  'copy:follow',
  'pay:read',
  'pay:write',
  'pay:refund',
  'pay:payout',
  'pay:onboard',
  'token:read',
  'token:stake',
  'blueprint:read',
  'blueprint:write',
  'bank:read',
  'bank:write',
  'bank:card',
  'launch:read',
  'launch:write',
  'market:read',
  'market:write',
  'market:ops',
  'academy:read',
  'academy:write',
  'agents:read',
  'agents:execute',
  'notify:read',
  'notify:write',
  'support:read',
  'support:write',
  'support:ops',
  'support:lookup',
  'tax:read',
  'tax:write',
  'campaigns:read',
  'campaigns:write',
  'campaigns:ops',
  'ops:read',
  'ops:write',
  'protocol:read',
  'quant:read',
  'quant:run',
  'admin:read',
  'admin:write',
  'admin:treasury',
  'admin:compliance',
];

describe('scopeWords', () => {
  it('names the scopes the issue saw in plain words', () => {
    expect(scopeWords(t, 'identity:read')).toBe('Your profile and security: see');
    expect(scopeWords(t, 'trade:write')).toBe('Trading: make changes');
    expect(scopeWords(t, 'bank:write')).toBe('Bank: make changes');
  });

  it('has words for every scope the platform defines today', () => {
    expect(SCOPES.filter((scope) => scopeWords(t, scope) === scope)).toEqual([]);
  });

  it('shows a scope it has no words for as it is, never hiding it', () => {
    expect(scopeWords(t, 'newarea:read')).toBe('newarea:read');
    expect(scopeWords(t, 'trade:write:extra')).toBe('trade:write:extra');
  });
});
