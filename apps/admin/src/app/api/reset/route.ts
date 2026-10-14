import {
  adminSessionConfig,
  AdminSessionError,
  adminSessionErrorResponse,
  assertAdminOrigin,
  founderEdgeCall,
} from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';
import { limitedResponse, resetLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store' } as const;

/**
 * Forgotten password, public: the founder has the authenticator app AND an unused recovery code. Origin check only (there is no
 * session to check). Every input is allowlisted and length-capped. A refusal is deliberately the same whatever the reason
 * (unknown account, wrong code, no authenticator), so this route is not a way to find out who has an account. The one exception
 * is the rate limit, because waiting is the only useful thing to tell someone who has been counted out.
 */
export async function POST(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    // Public and unauthenticated: count every attempt per client before doing anything else (see lib/rate-limit).
    const limited = limitedResponse(resetLimiter, request);
    if (limited) return limited;
    const input = await readAdminJson(request);
    if (
      Object.keys(input).some((key) => !['identifier', 'totpCode', 'recoveryCode', 'newPassword'].includes(key)) ||
      typeof input.identifier !== 'string' ||
      !input.identifier.trim() ||
      input.identifier.length > 254 ||
      typeof input.totpCode !== 'string' ||
      !/^\d{6}$/.test(input.totpCode) ||
      typeof input.recoveryCode !== 'string' ||
      !/^[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5}$/.test(input.recoveryCode) ||
      typeof input.newPassword !== 'string' ||
      input.newPassword.length < 12 ||
      input.newPassword.length > 200
    )
      throw new AdminSessionError('admin.reset_refused', 400);
    await founderEdgeCall(config, 'identity', 'auth.resetPassword', 'POST', {
      identifier: input.identifier,
      totpCode: input.totpCode,
      // Identity stores recovery codes in upper case and matches them exactly, so a lower-case entry would burn an attempt.
      recoveryCode: input.recoveryCode.toUpperCase(),
      newPassword: input.newPassword,
    });
    return Response.json({ reset: true }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AdminSessionError) {
      if (error.upstreamCode === 'auth.too_many_attempts')
        return Response.json({ code: 'admin.reset_rate_limited' }, { status: 429, headers: HEADERS });
      // Not configured, or the edge is unreachable: nothing to do with the details, and says nothing about any account.
      if (error.code === 'admin.session_unconfigured' || error.code === 'admin.upstream_unavailable')
        return adminSessionErrorResponse(error);
      if (error.code === 'admin.session_origin') return adminSessionErrorResponse(error);
    }
    return Response.json({ code: 'admin.reset_refused' }, { status: 400, headers: HEADERS });
  }
}
