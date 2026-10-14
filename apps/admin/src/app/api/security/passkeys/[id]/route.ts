import { AdminSessionError, adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { parseStepUpProof, withStepUp } from '@/lib/step-up';
import { authorizedInput, NO_STORE, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/** Remove one passkey, after a fresh proof in the body. Whether the last one may go is svc-identity's rule, not ours. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, config, input } = await authorizedInput(request, ['proof']);
    const proof = parseStepUpProof(input.proof);
    const { id } = await context.params;
    // Credential ids are base64url. Anything else is not one of ours, so it never leaves this process.
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(id)) throw new AdminSessionError('admin.security_input', 400);
    const removed = await withStepUp(config, session, proof, (token) =>
      founderEdgeCall(config, 'identity', 'webauthn.remove', 'POST', { credentialId: id }, token),
    );
    if (typeof (removed as { removed?: unknown } | null)?.removed !== 'boolean') throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ removed: (removed as { removed: boolean }).removed }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
