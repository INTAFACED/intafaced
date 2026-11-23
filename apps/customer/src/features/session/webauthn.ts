import { authoredRefusal, type ApiClient, type ApiResult } from '../../shared/api';
import { type Session } from './session';
import { IDENTITY_AUTH_STEP_UP_OPTIONS } from '@intafaced/contracts/identity-auth-procedures';
import {
  IDENTITY_WEBAUTHN_AUTH_OPTIONS,
  IDENTITY_WEBAUTHN_REGISTER_OPTIONS,
  IDENTITY_WEBAUTHN_AUTH_VERIFY,
  IDENTITY_WEBAUTHN_REGISTER_VERIFY,
} from '@intafaced/contracts/identity-webauthn-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

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
  const options = await api.call(IDENTITY_WEBAUTHN_AUTH_OPTIONS, { identifier }, { signal: intent.signal });
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
    return api.call(
      IDENTITY_WEBAUTHN_AUTH_VERIFY,
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
  const options = await api.call(IDENTITY_WEBAUTHN_REGISTER_OPTIONS, undefined);
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
    return api.call(IDENTITY_WEBAUTHN_REGISTER_VERIFY, {
      id: credential.id,
      rawId: base64url(credential.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: base64url(response.clientDataJSON),
        attestationObject: base64url(response.attestationObject),
        transports: response.getTransports(),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    });
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
  const options = await api.call(IDENTITY_AUTH_STEP_UP_OPTIONS, undefined, { signal });
  if (!options.ok) return options;
  return signAssertion(options.data, signal);
}

/** Asks the browser to sign options the service already issued. Shared by every passkey confirmation. */
export async function signAssertion(
  json: ProcedureOutput<typeof IDENTITY_WEBAUTHN_AUTH_OPTIONS>,
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
