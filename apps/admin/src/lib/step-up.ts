import { AdminSessionError, founderEdgeCall, type AdminSessionConfig, type FounderSession } from './founder-session';

/**
 * Step-up proof for the founder Security page.
 *
 * A sensitive action (set a password, replace the authenticator, new recovery codes) needs a second-factor proof from the
 * founder: a code from the authenticator app, an unused recovery code, or a passkey. svc-identity turns the proof into a
 * five-minute step-up token. This module takes the proof, asks for that token with the founder's own token and hands it to
 * ONE action in the same request. The step-up token is never stored, logged or returned: it lives in a local variable for
 * the length of the callback.
 */

/** The same field as sign-in: a 6-digit code, or a recovery code (XXXXX-XXXXX). */
export const TOTP_OR_RECOVERY = /^(\d{6}|[0-9A-Fa-f]{5}-[0-9A-Fa-f]{5})$/;

export interface WebauthnAssertion {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
  clientExtensionResults?: Record<string, unknown>;
}

export type StepUpProof = { totpCode: string } | { webauthn: WebauthnAssertion };

const FIELD_MAX = 4096;
const EXTENSIONS_MAX = 2048;
const TOKEN_MAX = 2600;

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function boundedString(value: unknown, max = FIELD_MAX): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** Only the known keys survive, each a bounded string, so nothing else reaches svc-identity. Returns null for anything else. */
function parseAssertion(value: unknown): WebauthnAssertion | null {
  const row = plainObject(value);
  const response = plainObject(row?.response);
  if (!row || !response || row.type !== 'public-key') return null;
  const id = boundedString(row.id, 1024);
  const rawId = boundedString(row.rawId, 1024);
  const clientDataJSON = boundedString(response.clientDataJSON);
  const authenticatorData = boundedString(response.authenticatorData);
  const signature = boundedString(response.signature);
  if (!id || !rawId || !clientDataJSON || !authenticatorData || !signature) return null;
  const userHandle = response.userHandle;
  if (userHandle !== undefined && userHandle !== null && boundedString(userHandle, 1024) === null) return null;
  const extensions = row.clientExtensionResults;
  if (extensions !== undefined) {
    const record = plainObject(extensions);
    if (!record || JSON.stringify(record).length > EXTENSIONS_MAX) return null;
  }
  return {
    id,
    rawId,
    type: 'public-key',
    response: {
      clientDataJSON,
      authenticatorData,
      signature,
      ...(userHandle !== undefined ? { userHandle: userHandle as string | null } : {}),
    },
    ...(extensions !== undefined ? { clientExtensionResults: extensions as Record<string, unknown> } : {}),
  };
}

/** Exactly one of `{totpCode}` or `{webauthn}`. Anything else is a 400 before any upstream call. */
export function parseStepUpProof(value: unknown): StepUpProof {
  const row = plainObject(value);
  if (row) {
    const keys = Object.keys(row);
    if (keys.length === 1 && keys[0] === 'totpCode' && typeof row.totpCode === 'string' && TOTP_OR_RECOVERY.test(row.totpCode))
      // Recovery codes are stored upper case and matched exactly; a lower-case entry would be refused and burn an attempt.
      return { totpCode: row.totpCode.toUpperCase() };
    if (keys.length === 1 && keys[0] === 'webauthn') {
      const webauthn = parseAssertion(row.webauthn);
      if (webauthn) return { webauthn };
    }
  }
  throw new AdminSessionError('admin.proof_input', 400);
}

/**
 * Proves the second factor with the founder's own token, then runs `action` with the step-up token it earned. The token is
 * passed to the callback and nowhere else; the callback's result is returned, the token is not.
 */
export async function withStepUp<T>(
  config: AdminSessionConfig,
  session: Pick<FounderSession, 'accessToken'>,
  proof: StepUpProof,
  action: (stepUpToken: string) => Promise<T>,
): Promise<T> {
  const raw = await founderEdgeCall(config, 'identity', 'auth.stepUp', 'POST', proof, session.accessToken);
  const token = plainObject(raw)?.accessToken;
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_MAX) throw new AdminSessionError('admin.upstream_invalid', 502);
  return action(token);
}
