import { adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { parseStepUpProof, withStepUp } from '@/lib/step-up';
import { authorizedInput, NO_STORE, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/**
 * The challenge for adding a passkey. Adding a sign-in factor needs a fresh proof (step-up), so a hijacked session alone cannot
 * swap factors. The challenge is bound to the user, not to the token that asked, so `verify` can use the founder's own token.
 */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['proof']);
    const proof = parseStepUpProof(input.proof);
    const options = await withStepUp(config, session, proof, (token) =>
      founderEdgeCall(config, 'identity', 'webauthn.registerOptions', 'POST', {}, token),
    );
    return Response.json(options, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
