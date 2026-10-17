import { describe, expect, it } from 'vitest';
import {
  assertDelegatableScopes,
  INTERACTIVE_ONLY_SCOPES,
  SCOPES,
  scopesForFounderSession,
  SESSION_MFA_SCOPES,
  SESSION_SCOPES,
  type Scope,
} from './scopes.js';

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
    expect(() => assertDelegatableScopes(['admin:write'], ['admin:write', 'support:ops'])).toThrow(/cannot be granted to an API key/);
    expect(() => assertDelegatableScopes(['support:ops'], ['support:ops'])).toThrow(/cannot be granted to an API key/);
  });

  it('classifies every founder and operator desk scope as interactive-only', () => {
    // Name rule and the live grant, computed here rather than copied from
    // INTERACTIVE_ONLY_SCOPES. A new admin:* or *:ops scope, or a new scope
    // scopesForFounderSession starts handing out, fails until it is classified.
    const fromNames = SCOPES.filter((scope) => scope.startsWith('admin:') || scope.endsWith(':ops'));
    const fromFounderGrant = scopesForFounderSession([...SESSION_SCOPES], { founder: true, mfa: true }).filter(
      (scope) => !(SESSION_SCOPES as readonly string[]).includes(scope),
    );
    const desk = [...new Set<Scope>([...fromNames, ...fromFounderGrant])];

    expect(desk).toEqual(
      expect.arrayContaining(['admin:read', 'admin:write', 'admin:treasury', 'admin:compliance', 'support:ops', 'market:ops']),
    );
    expect(desk).toHaveLength(6);

    for (const scope of desk) {
      expect(INTERACTIVE_ONLY_SCOPES, scope).toContain(scope);
      expect(() => assertDelegatableScopes([scope], [scope])).toThrow(/cannot be granted to an API key/);
    }

    // 2FA on the session is the value-movement subset plus pay:onboard
    // (#4897 left it on the gate requireScope used before this split).
    // Desk reads are issued before MFA; folding them into SESSION_MFA_SCOPES
    // would lock the founder out of the desk they were just given.
    for (const scope of SESSION_MFA_SCOPES) {
      expect(INTERACTIVE_ONLY_SCOPES, scope).toContain(scope);
    }
    for (const scope of ['admin:read', 'admin:write', 'admin:compliance', 'support:ops', 'market:ops'] as const) {
      expect(SESSION_MFA_SCOPES, scope).not.toContain(scope);
    }
  });
});
