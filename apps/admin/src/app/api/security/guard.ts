import {
  AdminSessionError,
  authorizeAdminRequest,
  founderCookie,
  founderEdgeCall,
  type AdminSessionConfig,
  type FounderSession,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

/**
 * Shared plumbing for the Security routes. Every route starts with `authorizeAdminRequest` (origin, CSRF on a mutation and the
 * live founder check) before it reads anything else.
 */

export const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * The identity refusal codes the Security page has copy for (see `securityErrorMessage`), and so the only ones its routes pass
 * on. Everything else goes out as this server's own code alone.
 */
export const SECURITY_UPSTREAM = [
  'auth.too_many_attempts',
  'auth.password_unchanged',
  'auth.password_policy',
  'auth.mfa_required',
  'auth.invalid_credentials',
  'auth.mfa_invalid',
] as const;

/** Authorises the request, then reads a JSON body that may only carry `keys`. */
export async function authorizedInput(
  request: Request,
  keys: readonly string[],
): Promise<{ session: FounderSession; config: AdminSessionConfig; input: Record<string, unknown> }> {
  const { session, config } = await authorizeAdminRequest(request);
  const input = await readAdminJson(request);
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new AdminSessionError('admin.security_input', 400);
  return { session, config, input };
}

/** Same minimum and maximum as svc-identity's register rules (12 to 200). */
export function newPasswordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 200) throw new AdminSessionError('admin.security_input', 400);
  return value;
}

export function currentPasswordInput(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) throw new AdminSessionError('admin.security_input', 400);
  return value;
}

/**
 * A password change or reset signs the founder out everywhere. The server session is ended (a failure here is not fatal: the
 * password change already revoked the other sessions and the cookie is cleared regardless) and the browser cookie is cleared.
 */
export async function signedOutResponse(config: AdminSessionConfig, session: FounderSession): Promise<Response> {
  await founderEdgeCall(config, 'identity', 'auth.logout', 'POST', { refreshToken: session.refreshToken }, session.accessToken).catch(
    () => undefined,
  );
  return Response.json({ signedOut: true }, { headers: { ...NO_STORE, 'set-cookie': founderCookie('', 0) } });
}
