import { z } from 'zod';
import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { sessionSchema, type Session } from './session';

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
      { signal: intent.signal },
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

/** A passkey answer in the shape `auth.stepUpPay` takes. */
export type PasskeyAssertion = {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
  clientExtensionResults: Record<string, unknown>;
};
type Failed = Extract<ApiResult<never>, { ok: false }>;
const passkeyFailure = (code: string, reason: Failed['reason'] = 'error'): Failed => ({ ok: false, reason, message: code, code });

/**
 * Asks the person's passkey to confirm a payment. The identity service issues a single-use challenge for this person
 * (`auth.stepUpOptions`); the browser signs it; the answer goes back to `auth.stepUpPay` and nowhere else. Nothing here
 * ends the session on a refusal of the assertion itself (`auth.webauthn_invalid`); any other 401 is the normal sign-out path. A failure carries a `portal.passkey_*` code
 * the caller words itself.
 */
export async function requestPasskeyAssertion(api: ApiClient, signal?: AbortSignal): Promise<ApiResult<PasskeyAssertion>> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get)
    return passkeyFailure('portal.passkey_unavailable', 'not_supported');
  const options = await api.mutate('identity', 'auth.stepUpOptions', {}, authenticationOptions, { signal });
  if (!options.ok) return options;
  return signAssertion(options.data, signal);
}

/** Asks the browser to sign options the service already issued. Shared by every passkey confirmation. */
export async function signAssertion(
  json: z.infer<typeof authenticationOptions>,
  signal?: AbortSignal,
): Promise<ApiResult<PasskeyAssertion>> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.get)
    return passkeyFailure('portal.passkey_unavailable', 'not_supported');
  const canonical = (value: string) => /^[A-Za-z0-9_-]+$/.test(value) && base64url(bytes(value)) === value;
  try {
    if (!canonical(json.challenge) || json.allowCredentials?.some((item) => !canonical(item.id)))
      return passkeyFailure('portal.passkey_unreadable', 'invalid_response');
    const credential = await navigator.credentials.get({
      signal,
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
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAssertionResponse) ||
      !canonical(credential.id) ||
      credential.id !== base64url(credential.rawId)
    )
      return passkeyFailure('portal.passkey_unreadable');
    const response = credential.response;
    return {
      ok: true,
      data: {
        id: credential.id,
        rawId: base64url(credential.rawId),
        type: 'public-key',
        response: {
          clientDataJSON: base64url(response.clientDataJSON),
          authenticatorData: base64url(response.authenticatorData),
          signature: base64url(response.signature),
          userHandle: response.userHandle ? base64url(response.userHandle) : null,
        },
        clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
      },
    };
  } catch (error) {
    return passkeyFailure(
      error instanceof DOMException && error.name === 'NotAllowedError' ? 'portal.passkey_stopped' : 'portal.passkey_failed',
    );
  }
}
