import { AuthError, type Principal } from './tokens.js';
import { INTERACTIVE_ONLY_SCOPES, PERSON_ONLY_SCOPES, SESSION_MFA_SCOPES, expandScopes, type Scope } from './scopes.js';

/**
 * Guards — the authorisation checks every service applies before doing work.
 *
 * These are plain functions rather than framework middleware so the same rule
 * is enforced identically from Fastify, from tRPC, from a queue worker, and
 * from an agent tool call. A guard throws; it never returns a boolean that a
 * caller can forget to check.
 */

export function requireScope(principal: Principal, scope: Scope): void {
  const granted = expandScopes(principal.scopes);

  if (!granted.has(scope)) {
    throw new AuthError(`Scope "${scope}" is required`, 'scope.denied');
  }

  // Checked before the MFA gate. A key token is minted with mfa:false, and a
  // forged one can claim mfa:true. Either way an API key must not exercise an
  // interactive-only scope — including a desk scope already stored on a key
  // that was issued before the scope was classified. `scope.denied` would tell
  // the caller to ask for a scope the key already lists.
  if (
    isApiKeyPrincipal(principal) &&
    ((INTERACTIVE_ONLY_SCOPES as readonly string[]).includes(scope) || (PERSON_ONLY_SCOPES as readonly string[]).includes(scope))
  ) {
    throw new AuthError(`Scope "${scope}" requires an interactive session and cannot be used from an API key`, 'scope.interactive_only');
  }

  // Value leaving the platform needs a 2FA-backed session (§9). Desk scopes
  // that are interactive-only but not in SESSION_MFA_SCOPES keep their own
  // requireMfa, so a founder can still read the desk before stepping up.
  if ((SESSION_MFA_SCOPES as readonly string[]).includes(scope) && !principal.mfa) {
    throw new AuthError(`Scope "${scope}" requires two-factor authentication`, 'mfa.required');
  }
}

function isApiKeyPrincipal(principal: Principal): boolean {
  return typeof principal.kid === 'string' && principal.kid.length > 0;
}

export function requireMfa(principal: Principal): void {
  if (!principal.mfa) throw new AuthError('This action requires two-factor authentication', 'mfa.required');
}

export const TIER_ORDER = { none: 0, basic: 1, full: 2, institutional: 3 } as const;

/**
 * `tier.insufficient`, not `scope.denied`. The caller holds the authority and
 * is short of verification — the one refusal on this page that names something
 * the user can go and fix. The required tier is in the message so the client
 * does not have to guess which step to send them to.
 */
export function requireTier(principal: Principal, tier: Principal['tier']): void {
  if (TIER_ORDER[principal.tier] < TIER_ORDER[tier]) {
    throw new AuthError(`Verification tier "${tier}" is required`, 'tier.insufficient');
  }
}

/**
 * Ownership check. A principal may act on its own resources, and on its own
 * sub-accounts — never on another user's, whatever scopes it holds.
 *
 * Its own code, because this one is never a prompt: no amount of verifying, and
 * no scope, makes another account's row yours. A client that treated it as
 * `scope.denied` would offer an upgrade path that leads nowhere.
 */
export function requireOwnership(principal: Principal, ownerUserId: string): void {
  if (principal.userId !== ownerUserId) {
    throw new AuthError('This resource belongs to another account', 'ownership.denied');
  }
}

/** Extract a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
