import { adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { parseStepUpProof, withStepUp } from '@/lib/step-up';
import { authorizedInput, newPasswordInput, signedOutResponse, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/** Forgot the password but can still prove a second factor (usually a passkey sign-in): step up, set a new password, sign out. */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['newPassword', 'proof']);
    const newPassword = newPasswordInput(input.newPassword);
    const proof = parseStepUpProof(input.proof);
    await withStepUp(config, session, proof, (token) =>
      founderEdgeCall(config, 'identity', 'auth.setPassword', 'POST', { newPassword }, token),
    );
    return await signedOutResponse(config, session);
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
