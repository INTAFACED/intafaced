import { describe, expect, it } from 'vitest';
import {
  assertDelegatableScopes,
  expandScopes,
  FOUNDER_SCOPE_INVALID,
  FOUNDER_SESSION_SCOPE_ALLOWLIST,
  FounderScopeInvalidError,
  hasScope,
  INTERACTIVE_ONLY_SCOPES,
  parseFounderSessionScopes,
  SCOPES,
  scopesForFounderSession,
  SESSION_MFA_SCOPES,
  SESSION_SCOPES,
  type Scope,
} from './scopes.js';

const CONFIGURED: Scope[] = ['admin:compliance'];

describe('founder desk scopes', () => {
  it('leaves an ordinary session on SESSION_SCOPES', () => {
    expect(scopesForFounderSession([...SESSION_SCOPES], { founder: false, mfa: true, configured: CONFIGURED })).toEqual([
      ...SESSION_SCOPES,
    ]);
  });

  it('blank config gives a founder only the session scopes', () => {
    expect(scopesForFounderSession([...SESSION_SCOPES], { founder: true, mfa: true })).toEqual([...SESSION_SCOPES]);
    expect(scopesForFounderSession([...SESSION_SCOPES], { founder: true, mfa: true, configured: [] })).toEqual([...SESSION_SCOPES]);
  });

  it('a founder without MFA, a sub-account, or an API key gets none of the configured scopes', () => {
    const base = [...SESSION_SCOPES];
    for (const opts of [
      { founder: true, mfa: false, configured: [...FOUNDER_SESSION_SCOPE_ALLOWLIST] },
      { founder: true, mfa: true, subAccount: true, configured: [...FOUNDER_SESSION_SCOPE_ALLOWLIST] },
      { founder: true, mfa: true, apiKey: true, configured: [...FOUNDER_SESSION_SCOPE_ALLOWLIST] },
    ] as const) {
      const scopes = scopesForFounderSession(base, opts);
      for (const scope of FOUNDER_SESSION_SCOPE_ALLOWLIST) expect(scopes, JSON.stringify(opts)).not.toContain(scope);
    }
  });

  it('an MFA founder gets only the configured allowlist scopes, never treasury', () => {
    const scopes = scopesForFounderSession([...SESSION_SCOPES], {
      founder: true,
      mfa: true,
      configured: ['admin:compliance', 'admin:treasury'],
    });
    expect(scopes).toContain('admin:compliance');
    expect(scopes).not.toContain('admin:treasury');
    expect(scopes).not.toContain('admin:write');
  });

  it('refuses to copy founder desk scopes onto a key even when the session holds them', () => {
    expect(() => assertDelegatableScopes(['admin:write'], ['admin:write', 'support:ops'])).toThrow(/cannot be granted to an API key/);
    expect(() => assertDelegatableScopes(['support:ops'], ['support:ops'])).toThrow(/cannot be granted to an API key/);
    expect(() => assertDelegatableScopes(['support:lookup'], ['support:lookup'])).toThrow(/cannot be granted to an API key/);
  });

  it('classifies every founder and operator desk scope as interactive-only', () => {
    // Name rule and the live grant, computed here rather than copied from
    // INTERACTIVE_ONLY_SCOPES. A new admin:* or *:ops scope, or a new scope
    // scopesForFounderSession starts handing out, fails until it is classified.
    const fromNames = SCOPES.filter((scope) => scope.startsWith('admin:') || scope.endsWith(':ops'));
    const fromFounderGrant = scopesForFounderSession([...SESSION_SCOPES], {
      founder: true,
      mfa: true,
      configured: [...FOUNDER_SESSION_SCOPE_ALLOWLIST],
    }).filter((scope) => !(SESSION_SCOPES as readonly string[]).includes(scope));
    const desk = [...new Set<Scope>([...fromNames, ...fromFounderGrant])];

    expect(desk).toEqual(
      expect.arrayContaining([
        'admin:read',
        'admin:write',
        'admin:treasury',
        'admin:compliance',
        'support:ops',
        'support:lookup',
        'market:ops',
        'campaigns:ops',
      ]),
    );
    expect(desk).toHaveLength(8);

    for (const scope of desk) {
      expect(INTERACTIVE_ONLY_SCOPES, scope).toContain(scope);
      expect(() => assertDelegatableScopes([scope], [scope])).toThrow(/cannot be granted to an API key/);
    }

    // 2FA on the session is the value-movement subset plus pay:onboard
    // (#4897 left it on the gate requireScope used before this split).
    // The founder grant requires MFA in scopesForFounderSession. Folding the
    // desk scopes into SESSION_MFA_SCOPES would also refuse them on a key
    // token that already fails the interactive-only check, and would change
    // requireScope for every other holder.
    for (const scope of SESSION_MFA_SCOPES) {
      expect(INTERACTIVE_ONLY_SCOPES, scope).toContain(scope);
    }
    for (const scope of [
      'admin:read',
      'admin:write',
      'admin:compliance',
      'support:ops',
      'support:lookup',
      'market:ops',
      'campaigns:ops',
    ] as const) {
      expect(SESSION_MFA_SCOPES, scope).not.toContain(scope);
    }
  });

  it('support:lookup grants only itself: no queue work, no customer scopes, no admin read', () => {
    const founder = scopesForFounderSession([...SESSION_SCOPES], { founder: true, mfa: true, configured: ['support:lookup'] });
    expect(founder).toContain('support:lookup');
    expect(founder).not.toContain('support:ops');
    expect(expandScopes(['support:lookup'])).toEqual(new Set(['support:lookup']));
    expect(hasScope(['support:lookup'], 'support:ops')).toBe(false);
    expect(hasScope(['support:lookup'], 'admin:read')).toBe(false);
    expect(hasScope(['support:ops'], 'support:lookup')).toBe(false);
    expect(parseFounderSessionScopes('support:ops,support:lookup')).toEqual(['support:ops', 'support:lookup']);
  });

  it('refuses admin:treasury, a pay scope, and a typo at parse', () => {
    expect(parseFounderSessionScopes(undefined)).toEqual([]);
    expect(parseFounderSessionScopes('')).toEqual([]);
    expect(parseFounderSessionScopes('  ')).toEqual([]);
    expect(parseFounderSessionScopes('admin:compliance, admin:read')).toEqual(['admin:compliance', 'admin:read']);
    for (const raw of [
      'admin:treasury',
      'trade:withdraw',
      'bank:card',
      'pay:read',
      'pay:payout',
      'admin:reed',
      'token:read',
      'admin:read,',
    ]) {
      expect(() => parseFounderSessionScopes(raw), raw).toThrow(FounderScopeInvalidError);
      try {
        parseFounderSessionScopes(raw);
      } catch (err) {
        expect((err as FounderScopeInvalidError).code, raw).toBe(FOUNDER_SCOPE_INVALID);
      }
    }
  });
});
