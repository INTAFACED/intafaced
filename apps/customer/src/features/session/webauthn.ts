import { z } from 'zod';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { sessionSchema, type Session } from './session';
import { SESSION_TRANSPORT_HEADERS } from './session-sync';

const credentialDescriptor = z.object({ id: z.string(), type: z.literal('public-key'), transports: z.array(z.string()).optional() });
const authenticationOptions = z.object({
  challenge: z.string(),
  timeout: z.number().optional(),
  rpId: z.string().optional(),
  allowCredentials: z.array(credentialDescriptor).optional(),
  userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
});
const registrationOptions = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string().optional(), name: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int() })),
  timeout: z.number().optional(),
  excludeCredentials: z.array(credentialDescriptor).optional(),
  authenticatorSelection: z
    .object({
      authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
      residentKey: z.enum(['discouraged', 'preferred', 'required']).optional(),
      requireResidentKey: z.boolean().optional(),
      userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
    })
    .optional(),
  attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
});

function bytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)).buffer;
}
export function base64url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function signInWithPasskey(
  api: ApiClient,
  identifier: string,
  intent: {
    signal: AbortSignal;
    current: () => boolean;
    beforeOptions: () => boolean;
    optionsReceived: (answer: ApiResult<unknown>) => void;
    beforeVerify: () => boolean;
  },
): Promise<ApiResult<Session>> {
  const active = () => !intent.signal.aborted && intent.current();
  const changed = () => authoredRefusal('aborted', { key: 'accountChanged' });
  if (!active()) return changed();
  if (!identifier.trim()) return authoredRefusal('error', { key: 'passkeyIdentifier' });
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get)
    return authoredRefusal('not_supported', { key: 'passkeySecure' });
  if (!intent.beforeOptions() || !active()) return changed();
  const options = await api.mutate('identity', 'webauthn.authOptions', { identifier }, authenticationOptions, { signal: intent.signal });
  if (!options.ok) return options;
  const canonical = (value: string) => {
    try {
      return /^[A-Za-z0-9_-]+$/.test(value) && base64url(bytes(value)) === value;
    } catch {
      return false;
    }
  };
  const json = options.data;
  if (
    !canonical(json.challenge) ||
    (json.rpId !== undefined && !json.rpId.trim()) ||
    (json.timeout !== undefined && (!Number.isSafeInteger(json.timeout) || json.timeout <= 0)) ||
    json.allowCredentials?.some((item) => !canonical(item.id)) ||
    (json.allowCredentials && new Set(json.allowCredentials.map((item) => item.id)).size !== json.allowCredentials.length)
  )
    return authoredRefusal('uncertain', { key: 'unverifiedWrite' });
  // The original options reply is known; a departed view may not start a browser ceremony.
  intent.optionsReceived(options);
  if (!active()) return changed();
  try {
    const credential = await navigator.credentials.get({
      signal: intent.signal,
      publicKey: {
        ...json,
        challenge: bytes(json.challenge),
        allowCredentials: json.allowCredentials?.map((item) => ({
          id: bytes(item.id),
          type: 'public-key' as const,
          transports: item.transports as AuthenticatorTransport[] | undefined,
        })),
      },
    });
    if (!active()) return changed();
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAssertionResponse) ||
      !canonical(credential.id) ||
      credential.id !== base64url(credential.rawId) ||
      (json.allowCredentials?.length && !json.allowCredentials.some((item) => item.id === credential.id))
    )
      return authoredRefusal('error', { key: 'passkeyAssertion' });
    const response = credential.response;
    if (!intent.beforeVerify() || !active()) return changed();
    return api.mutate(
      'identity',
      'webauthn.authVerify',
      {
        identifier,
        credential: {
          id: credential.id,
          rawId: base64url(credential.rawId),
          type: 'public-key',
          response: {
            clientDataJSON: base64url(response.clientDataJSON),
            authenticatorData: base64url(response.authenticatorData),
            signature: base64url(response.signature),
            userHandle: response.userHandle ? base64url(response.userHandle) : null,
          },
          clientExtensionResults: credential.getClientExtensionResults(),
        },
      },
      sessionSchema,
      { signal: intent.signal, headers: SESSION_TRANSPORT_HEADERS },
    );
  } catch (error) {
    if (!active()) return changed();
    return authoredRefusal('error', {
      key: error instanceof DOMException && error.name === 'NotAllowedError' ? 'passkeySignInStopped' : 'passkeySignInFailed',
    });
  }
}

export async function enrollPasskey(api: ApiClient): Promise<ApiResult<{ credentialId: string }>> {
  if (!window.isSecureContext || !window.PublicKeyCredential) return authoredRefusal('not_supported', { key: 'passkeySecure' });
  const options = await api.mutate('identity', 'webauthn.registerOptions', {}, registrationOptions);
  if (!options.ok) return options;
  try {
    const json = options.data;
    const credential = await navigator.credentials.create({
      publicKey: {
        ...json,
        challenge: bytes(json.challenge),
        user: { ...json.user, id: bytes(json.user.id) },
        excludeCredentials: json.excludeCredentials?.map((item) => ({
          id: bytes(item.id),
          type: 'public-key' as const,
          transports: item.transports as AuthenticatorTransport[] | undefined,
        })),
      },
    });
    if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse))
      return authoredRefusal('error', { key: 'passkeyMissing' });
    const response = credential.response;
    return api.mutate(
      'identity',
      'webauthn.registerVerify',
      {
        id: credential.id,
        rawId: base64url(credential.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(response.clientDataJSON),
          attestationObject: base64url(response.attestationObject),
          transports: response.getTransports(),
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      },
      z.object({ credentialId: z.string() }),
    );
  } catch (error) {
    return authoredRefusal('error', {
      key: error instanceof DOMException && error.name === 'NotAllowedError' ? 'passkeyCreateStopped' : 'passkeyCreateFailed',
    });
  }
}
