import { AdminSessionError, adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { parseStepUpProof, withStepUp } from '@/lib/step-up';
import { authorizedInput, NO_STORE, SECURITY_UPSTREAM } from '../guard';

export const dynamic = 'force-dynamic';

/** Step up, then replace every recovery code. The new codes are returned once; the old ones stop working. */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['proof']);
    const proof = parseStepUpProof(input.proof);
    const made = await withStepUp(config, session, proof, (token) =>
      founderEdgeCall(config, 'identity', 'totp.regenerateRecoveryCodes', 'POST', {}, token),
    );
    const codes = (made as { recoveryCodes?: unknown } | null)?.recoveryCodes;
    if (
      !Array.isArray(codes) ||
      codes.length < 1 ||
      codes.length > 20 ||
      codes.some((code) => typeof code !== 'string' || !code || code.length > 64)
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ recoveryCodes: codes as string[] }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
