/**
 * Verify a passkey via @simplewebauthn/server so a later place can require it.
 * Refuse if no enrolled credential. No invented challenge — the library mints it.
 * RP id/origin come from the caller, never a localhost default.
 */
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import type { Sql } from 'postgres';
import { b64urlDecode, type ChallengeStorePort } from './webauthn.js';
import { requireOrigin, requireRpId, sqlPasskeyChallenges, type PasskeyRp, type StoredPasskey } from './enroll-passkey.js';

export class VerifyPasskeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.rp_id_missing' | 'auth.origin_missing' | 'auth.not_found' | 'auth.passkey_missing' | 'auth.webauthn_invalid',
  ) {
    super(message);
    this.name = 'VerifyPasskeyError';
  }
}

export type VerifyPasskeyCeremony = {
  generate: typeof generateAuthenticationOptions;
  verify: typeof verifyAuthenticationResponse;
};

const defaultCeremony: VerifyPasskeyCeremony = {
  generate: generateAuthenticationOptions,
  verify: verifyAuthenticationResponse,
};

function requireRp(rp: PasskeyRp): { rpId: string; origins: string[] } {
  try {
    const rpId = requireRpId(rp.rpId);
    const origins = requireOrigin(rp.origin);
    return { rpId, origins };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'auth.rp_id_missing' || code === 'auth.origin_missing') {
      throw new VerifyPasskeyError(err instanceof Error ? err.message : 'RP required', code);
    }
    throw err;
  }
}

function asCreds(raw: unknown): StoredPasskey[] {
  return Array.isArray(raw) ? (raw as StoredPasskey[]) : [];
}

function readClientChallenge(clientDataJSON: string): string | null {
  try {
    const json = JSON.parse(Buffer.from(clientDataJSON.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      challenge?: unknown;
    };
    return typeof json.challenge === 'string' && json.challenge.trim() !== '' ? json.challenge : null;
  } catch {
    return null;
  }
}

export { sqlPasskeyChallenges };

export async function beginVerifyPasskey(
  sql: Sql,
  userId: string,
  rp: PasskeyRp,
  challenges: ChallengeStorePort,
  ceremony: VerifyPasskeyCeremony = defaultCeremony,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpId } = requireRp(rp);
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${userId}
  `;
  const user = rows[0];
  if (!user) throw new VerifyPasskeyError('User not found', 'auth.not_found');

  const existing = asCreds(user.webauthn_creds);
  if (existing.length === 0) {
    throw new VerifyPasskeyError('No enrolled passkey', 'auth.passkey_missing');
  }

  const options = await ceremony.generate({
    rpID: rpId,
    userVerification: 'required',
    allowCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as 'internal'[] | undefined })),
  });
  await challenges.put('authentication', options.challenge, userId);
  return options;
}

export async function verifyPasskey(
  sql: Sql,
  userId: string,
  rp: PasskeyRp,
  response: AuthenticationResponseJSON,
  challenges: ChallengeStorePort,
  ceremony: VerifyPasskeyCeremony = defaultCeremony,
): Promise<{ credentialId: string; verified: true }> {
  const { rpId, origins } = requireRp(rp);
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${userId}
  `;
  const user = rows[0];
  if (!user) throw new VerifyPasskeyError('User not found', 'auth.not_found');

  const existing = asCreds(user.webauthn_creds);
  if (existing.length === 0) {
    throw new VerifyPasskeyError('No enrolled passkey', 'auth.passkey_missing');
  }

  const stored = existing.find((c) => c.credentialId === response.id);
  if (!stored) throw new VerifyPasskeyError('No enrolled passkey matches this authenticator', 'auth.passkey_missing');

  const clientChallenge = readClientChallenge(response.response.clientDataJSON);
  if (!clientChallenge) throw new VerifyPasskeyError('Invalid WebAuthn response', 'auth.webauthn_invalid');

  const held = await challenges.take(clientChallenge, 'authentication');
  if (!held || held.userId !== userId) {
    throw new VerifyPasskeyError('WebAuthn challenge expired or already used', 'auth.webauthn_invalid');
  }

  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await ceremony.verify({
      response,
      expectedChallenge: held.challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(b64urlDecode(stored.publicKey)),
        counter: stored.counter,
        transports: stored.transports as 'internal'[] | undefined,
      },
    });
  } catch {
    throw new VerifyPasskeyError('Invalid WebAuthn response', 'auth.webauthn_invalid');
  }
  if (!verified.verified) {
    throw new VerifyPasskeyError('Invalid WebAuthn response', 'auth.webauthn_invalid');
  }

  const nextCounter = verified.authenticationInfo?.newCounter ?? stored.counter;
  const next = existing.map((c) =>
    c.credentialId === stored.credentialId ? { ...c, counter: nextCounter, lastVerifiedAt: new Date().toISOString() } : c,
  );
  await sql`
    UPDATE users
       SET webauthn_creds = ${sql.json(next as never)}, updated_at = now()
     WHERE id = ${userId}
  `;
  return { credentialId: stored.credentialId, verified: true };
}
