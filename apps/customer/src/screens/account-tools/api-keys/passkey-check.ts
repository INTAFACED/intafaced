import { z } from 'zod';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../../shared/api';
import { base64url } from '../../../features/session/webauthn';

/**
 * Confirming a passkey with the service (`beginVerifyPasskey`, then `verifyPasskey`). The service will not mint an
 * API key until the account has done this once, so it is the "extra security step" for creating a key. The challenge
 * comes from the service and goes back unchanged; nothing is decided here.
 */

const credentialDescriptor = z.object({ id: z.string(), type: z.literal('public-key'), transports: z.array(z.string()).optional() });
const optionsSchema = z.object({
  challenge: z.string(),
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(credentialDescriptor).optional(),
  userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
});
export type VerifyOptions = z.infer<typeof optionsSchema>;
const verifiedSchema = z.object({ credentialId: z.string(), verified: z.literal(true) });

const urlSafe = /^[A-Za-z0-9_-]+$/;
export function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!urlSafe.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
  } catch {
    return null;
  }
}

/** The browser's request options from the service's JSON, or null when any id or challenge is not base64url. */
export function requestOptionsFrom(json: VerifyOptions): PublicKeyCredentialRequestOptions | null {
  const challenge = decodeBase64Url(json.challenge);
  if (!challenge) return null;
  const allow: PublicKeyCredentialDescriptor[] = [];
  for (const item of json.allowCredentials ?? []) {
    const id = decodeBase64Url(item.id);
    if (!id) return null;
    allow.push({ id, type: 'public-key', transports: item.transports as AuthenticatorTransport[] | undefined });
  }
  return {
    challenge,
    ...(json.timeout === undefined ? {} : { timeout: json.timeout }),
    ...(json.rpId === undefined ? {} : { rpId: json.rpId }),
    ...(json.userVerification === undefined ? {} : { userVerification: json.userVerification }),
    ...(allow.length ? { allowCredentials: allow } : {}),
  };
}

export async function confirmPasskey(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<{ verified: true }>> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get)
    return authoredRefusal('not_supported', { key: 'passkeySecure' });
  const options = await api.mutate('identity', 'beginVerifyPasskey', {}, optionsSchema, { signal });
  if (!options.ok) return options;
  const publicKey = requestOptionsFrom(options.data);
  if (!publicKey) return authoredRefusal('error', { key: 'passkeyAssertion' });
  try {
    const credential = await navigator.credentials.get({ publicKey, signal });
    const response = credential && 'response' in credential ? (credential.response as AuthenticatorAssertionResponse) : null;
    if (!(credential instanceof PublicKeyCredential) || !response || !response.signature)
      return authoredRefusal('error', { key: 'passkeyAssertion' });
    const sent = await api.mutate(
      'identity',
      'verifyPasskey',
      {
        id: credential.id,
        rawId: base64url(credential.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(response.clientDataJSON),
          authenticatorData: base64url(response.authenticatorData),
          signature: base64url(response.signature),
          ...(response.userHandle ? { userHandle: base64url(response.userHandle) } : {}),
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      },
      verifiedSchema,
      { signal },
    );
    return sent.ok ? { ok: true, data: { verified: true } } : sent;
  } catch (error) {
    return authoredRefusal('error', {
      key: error instanceof DOMException && error.name === 'NotAllowedError' ? 'passkeySignInStopped' : 'passkeySignInFailed',
    });
  }
}
