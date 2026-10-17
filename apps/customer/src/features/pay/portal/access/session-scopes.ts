/**
 * The scopes the signed-in session actually carries. Identity signs them into the access token (`scopes` claim, see
 * `accessClaimsSchema` in packages/auth); the sign-in reply does not repeat them, so this reads that claim.
 *
 * This only decides what to draw (which controls are on). It does not prove anything: the token is not verified here
 * and every procedure checks its own scope on the service. A token that cannot be read gives `null`, which holds nothing.
 */
export function scopesOfAccessToken(token: string | null | undefined): ReadonlySet<string> | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const scopes = claims && typeof claims === 'object' ? (claims as { scopes?: unknown }).scopes : undefined;
    if (!Array.isArray(scopes)) return null;
    return new Set(scopes.filter((scope): scope is string => typeof scope === 'string'));
  } catch {
    return null;
  }
}
