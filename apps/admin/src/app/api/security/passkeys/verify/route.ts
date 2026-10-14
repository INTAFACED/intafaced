import { AdminSessionError, adminSessionErrorResponse, founderEdgeCall } from '@/lib/founder-session';
import { boundedString } from '@/lib/step-up';
import { authorizedInput, NO_STORE, SECURITY_UPSTREAM } from '../../guard';

export const dynamic = 'force-dynamic';

/** Finish adding a passkey. The body is the browser's registration credential; only the known fields are forwarded. */
export async function POST(request: Request) {
  try {
    const { session, config, input } = await authorizedInput(request, ['id', 'rawId', 'type', 'response', 'clientExtensionResults']);
    const response = input.response as Record<string, unknown> | null;
    const id = boundedString(input.id, 1024);
    const rawId = boundedString(input.rawId, 1024);
    const clientDataJSON = boundedString(response?.clientDataJSON);
    const attestationObject = boundedString(response?.attestationObject);
    const transports = response?.transports;
    const extensions = input.clientExtensionResults;
    if (
      !id ||
      !rawId ||
      input.type !== 'public-key' ||
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      !clientDataJSON ||
      !attestationObject ||
      Object.keys(response).some((key) => !['clientDataJSON', 'attestationObject', 'transports'].includes(key)) ||
      (transports !== undefined &&
        (!Array.isArray(transports) || transports.length > 8 || transports.some((item) => boundedString(item, 32) === null))) ||
      (extensions !== undefined &&
        (extensions === null || typeof extensions !== 'object' || Array.isArray(extensions) || JSON.stringify(extensions).length > 2048))
    )
      throw new AdminSessionError('admin.security_input', 400);
    const added = await founderEdgeCall(
      config,
      'identity',
      'webauthn.registerVerify',
      'POST',
      {
        id,
        rawId,
        type: 'public-key',
        response: { clientDataJSON, attestationObject, ...(transports !== undefined ? { transports } : {}) },
        ...(extensions !== undefined ? { clientExtensionResults: extensions } : {}),
      },
      session.accessToken,
    );
    const credentialId = (added as { credentialId?: unknown } | null)?.credentialId;
    if (typeof credentialId !== 'string' || !credentialId || credentialId.length > 1024)
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ credentialId }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
