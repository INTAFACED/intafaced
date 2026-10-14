import { adminSessionErrorResponse, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { NO_STORE, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/** The passkey challenge for a step-up proof. The browser signs it and sends the assertion back as `proof.webauthn`. */
export async function POST(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const options = await founderEdgeCall(config, 'identity', 'auth.stepUpOptions', 'POST', {}, session.accessToken);
    return Response.json(options, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
