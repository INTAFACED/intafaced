import { AdminSessionError, adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { parseStepUpProof, withStepUp } from '@/lib/step-up';
import { authorizedInput, NO_STORE, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/** Step up, then start replacing the authenticator. The new secret is returned once, for the QR code, and never stored here. */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['proof']);
    const proof = parseStepUpProof(input.proof);
    const begun = await withStepUp(config, session, proof, (token) =>
      founderEdgeCall(config, 'identity', 'totp.replaceBegin', 'POST', {}, token),
    );
    const { secret, uri } = (begun ?? {}) as { secret?: unknown; uri?: unknown };
    if (
      typeof secret !== 'string' ||
      !secret ||
      secret.length > 256 ||
      typeof uri !== 'string' ||
      !uri.startsWith('otpauth://') ||
      uri.length > 1024
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ secret, uri }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
