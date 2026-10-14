import { AdminSessionError, founderEdgeCall } from '@/lib/founder-session';
import { handleEnrolment, liveStepUpToken, withoutStepUp } from '@/lib/enrolment-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Completes passkey registration with the step-up token held in the cookie, then drops that token. Only after the authenticator. */
export function POST(request: Request) {
  return handleEnrolment(request, { confirmed: true }, async ({ session, config }) => {
    const input = await readAdminJson(request);
    const response = input.response as Record<string, unknown> | null;
    if (
      Object.keys(input).some((key) => !['id', 'rawId', 'type', 'response', 'clientExtensionResults'].includes(key)) ||
      !text(input.id, 1024) ||
      !text(input.rawId, 1024) ||
      input.type !== 'public-key' ||
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      Object.keys(response).some((key) => !['clientDataJSON', 'attestationObject', 'transports'].includes(key)) ||
      !text(response.clientDataJSON, 4096) ||
      !text(response.attestationObject, 8192) ||
      (response.transports !== undefined &&
        (!Array.isArray(response.transports) || response.transports.length > 8 || !response.transports.every((item) => text(item, 32)))) ||
      (input.clientExtensionResults !== undefined &&
        (!input.clientExtensionResults ||
          typeof input.clientExtensionResults !== 'object' ||
          Array.isArray(input.clientExtensionResults) ||
          JSON.stringify(input.clientExtensionResults).length > 2048))
    )
      throw new AdminSessionError('admin.enrol_input', 400);
    // Rebuilt field by field, so nothing but what is checked above reaches identity.
    const credential = {
      id: input.id,
      rawId: input.rawId,
      type: 'public-key',
      response: {
        clientDataJSON: response.clientDataJSON,
        attestationObject: response.attestationObject,
        ...(response.transports !== undefined ? { transports: response.transports } : {}),
      },
      ...(input.clientExtensionResults !== undefined ? { clientExtensionResults: input.clientExtensionResults } : {}),
    };
    await founderEdgeCall(
      config,
      'identity',
      'webauthn.registerVerify',
      'POST',
      credential,
      liveStepUpToken(session) ?? session.accessToken,
    );
    return { body: { registered: true }, session: withoutStepUp(session) };
  });
}
