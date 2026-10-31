import { signInChallengeSchema } from '@intafaced/contracts/identity-signin-challenge';
import {
  AdminSessionError,
  adminSessionConfig,
  adminSessionErrorResponse,
  assertAdminOrigin,
  founderEdgeCall,
} from '@/lib/founder-session';

export const dynamic = 'force-dynamic';

/**
 * Identity's sign-in challenge (I-signin-sessions-30) for the founder's own browser to solve, when `/api/session`
 * answered `auth.challenge_required`. This server only passes it through; it never solves one.
 */
export async function POST(request: Request) {
  try {
    const config = adminSessionConfig();
    assertAdminOrigin(request, config, true);
    const parsed = signInChallengeSchema.safeParse(await founderEdgeCall(config, 'identity', 'auth.challenge', 'POST', {}));
    if (!parsed.success) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(parsed.data, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
