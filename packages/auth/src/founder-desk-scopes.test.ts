import { describe, expect, it } from 'vitest';
import { assertDelegatableScopes, scopesForFounderSession, SESSION_SCOPES } from './scopes.js';

describe('founder desk scopes', () => {
  it('leaves an ordinary session on SESSION_SCOPES', () => {
    expect(scopesForFounderSession([...SESSION_SCOPES], { founder: false, mfa: true })).toEqual([...SESSION_SCOPES]);
  });

  it('gives a founder without MFA the desk reads only', () => {
    const scopes = scopesForFounderSession([...SESSION_SCOPES], { founder: true, mfa: false });
    expect(scopes).toContain('support:ops');
    expect(scopes).toContain('admin:read');
    expect(scopes).not.toContain('admin:write');
    expect(scopes).not.toContain('admin:treasury');
  });

  it('gives an MFA founder support, notify read, kill and treasury', () => {
    const scopes = scopesForFounderSession([...SESSION_SCOPES], { founder: true, mfa: true });
    expect(scopes).toEqual(expect.arrayContaining(['support:ops', 'admin:read', 'admin:write', 'admin:treasury']));
  });

  it('refuses to copy founder desk scopes onto a key even when the session holds them', () => {
    expect(() => assertDelegatableScopes(['admin:write'], ['admin:write', 'support:ops'])).toThrow(/interactive founder session/);
    expect(() => assertDelegatableScopes(['support:ops'], ['support:ops'])).toThrow(/interactive founder session/);
  });
});
