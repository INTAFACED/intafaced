/**
 * Enroll a passkey via @simplewebauthn/server so a later place can require it.
 * Refuse if RP id or origin is blank. No invented secret — the library mints
 * the challenge; RP id/origin come from the caller, never a localhost default.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { checkMayAddFactor, type FactorActor } from './factor-gate.js';
import { SqlChallengeStore, type ChallengeStorePort } from './webauthn.js';

export class EnrollPasskeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.rp_id_missing' | 'auth.origin_missing' | 'auth.not_found' | 'auth.webauthn_invalid' | 'identity.passkey_limit',
  ) {
    super(message);
    this.name = 'EnrollPasskeyError';
  }
}

export type PasskeyRp = { rpId: string; rpName?: string; origin: string | readonly string[] };

const LIBRARY_TRANSPORTS = ['ble', 'hybrid', 'internal', 'nfc', 'usb'] as const;

export function libraryTransports(raw: string[] | undefined): AuthenticatorTransport[] | undefined {
  if (!raw?.length) return undefined;
  const next = raw.filter((item): item is (typeof LIBRARY_TRANSPORTS)[number] => (LIBRARY_TRANSPORTS as readonly string[]).includes(item));
  return next.length > 0 ? next : undefined;
}

/** Zod wire → library JSON. Missing extensions stay empty; unknown transports dropped. */
export function toRegistrationResponseJSON(input: {
  id: string;
  rawId: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}): RegistrationResponseJSON {
  const transports = libraryTransports(input.response.transports);
  return {
    id: input.id,
    rawId: input.rawId,
    type: 'public-key',
    response: {
      clientDataJSON: input.response.clientDataJSON,
      attestationObject: input.response.attestationObject,
      ...(transports ? { transports } : {}),
    },
    clientExtensionResults: {},
  };
}

export type StoredPasskey = {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  /** Owner-visible name; absent until the person sets one. */
  label?: string;
  /** Derived at registration from the transports; absent on older rows (read with `passkeyKind`). */
  kind?: PasskeyKind;
  /** The actions it is kept for (passkey-purposes.ts); absent or empty for none in particular. */
  purposes?: string[];
};

export type PasskeyKind = 'platform' | 'cross_device' | 'security_key' | 'unknown';

/**
 * What the authenticator said about itself, never a guess: `internal` alone is a device passkey,
 * `hybrid` is a phone used from another device, usb/nfc/ble only is a security key. Anything else
 * (no transports, a mix that proves nothing) is `unknown`.
 */
export function passkeyKind(transports: readonly string[] | undefined): PasskeyKind {
  const t = new Set(transports ?? []);
  if (t.has('hybrid')) return 'cross_device';
  if (t.has('internal')) return 'platform';
  if (t.size > 0 && [...t].every((x) => x === 'usb' || x === 'nfc' || x === 'ble')) return 'security_key';
  return 'unknown';
}

export type PasskeyCeremony = {
  generate: typeof generateRegistrationOptions;
  verify: typeof verifyRegistrationResponse;
};

const defaultCeremony: PasskeyCeremony = {
  generate: generateRegistrationOptions,
  verify: verifyRegistrationResponse,
};

export function requireRpId(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EnrollPasskeyError('RP id is required', 'auth.rp_id_missing');
  }
  return value.trim();
}

export function requireOrigin(value: string | readonly string[] | null | undefined): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const origins = parts.map((s) => String(s).trim()).filter(Boolean);
  if (origins.length === 0) {
    throw new EnrollPasskeyError('origin is required', 'auth.origin_missing');
  }
  return origins;
}

function requireRp(rp: PasskeyRp): { rpId: string; rpName: string; origins: string[] } {
  const rpId = requireRpId(rp.rpId);
  const origins = requireOrigin(rp.origin);
  const rpName = typeof rp.rpName === 'string' && rp.rpName.trim() !== '' ? rp.rpName.trim() : rpId;
  return { rpId, rpName, origins };
}

function asCreds(raw: unknown): StoredPasskey[] {
  return Array.isArray(raw) ? (raw as StoredPasskey[]) : [];
}

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

export function sqlPasskeyChallenges(sql: Sql): ChallengeStorePort {
  return new SqlChallengeStore(sql);
}

export async function beginEnrollPasskey(
  sql: Sql,
  userId: string,
  rp: PasskeyRp,
  challenges: ChallengeStorePort,
  ceremony: PasskeyCeremony = defaultCeremony,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpId, rpName } = requireRp(rp);
  const rows = await sql<Array<{ email: string; handle: string; webauthn_creds: unknown }>>`
    SELECT email, handle, webauthn_creds FROM users WHERE id = ${userId}
  `;
  const user = rows[0];
  if (!user) throw new EnrollPasskeyError('User not found', 'auth.not_found');

  const existing = asCreds(user.webauthn_creds);
  const options = await ceremony.generate({
    rpName,
    rpID: rpId,
    userName: user.email,
    userID: new Uint8Array(Buffer.from(userId, 'utf8')),
    userDisplayName: user.handle,
    attestationType: 'none',
    supportedAlgorithmIDs: [-7],
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
      requireResidentKey: false,
    },
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
  });
  await challenges.put('registration', options.challenge, userId);
  return options;
}

export async function enrollPasskey(
  sql: Sql,
  userId: string,
  rp: PasskeyRp,
  response: RegistrationResponseJSON,
  challenges: ChallengeStorePort,
  actor: FactorActor,
  ceremony: PasskeyCeremony = defaultCeremony,
  limits: { readonly maxPerAccount?: number | undefined } = {},
): Promise<{ credentialId: string }> {
  const { rpId, origins } = requireRp(rp);
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${userId}
  `;
  const user = rows[0];
  if (!user) throw new EnrollPasskeyError('User not found', 'auth.not_found');

  const clientChallenge = readClientChallenge(response.response.clientDataJSON);
  if (!clientChallenge) throw new EnrollPasskeyError('Invalid WebAuthn response', 'auth.webauthn_invalid');

  const held = await challenges.take(clientChallenge, 'registration');
  if (!held || held.userId !== userId) {
    throw new EnrollPasskeyError('WebAuthn challenge expired or already used', 'auth.webauthn_invalid');
  }

  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await ceremony.verify({
      response,
      expectedChallenge: held.challenge,
      expectedOrigin: origins,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new EnrollPasskeyError('Invalid WebAuthn response', 'auth.webauthn_invalid');
  }
  if (!verified.verified || !verified.registrationInfo) {
    throw new EnrollPasskeyError('Invalid WebAuthn response', 'auth.webauthn_invalid');
  }

  const cred = verified.registrationInfo.credential;
  const stored: StoredPasskey = {
    credentialId: cred.id,
    publicKey: toB64url(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports,
    createdAt: new Date().toISOString(),
    kind: passkeyKind(cred.transports),
  };
  // The ceremony above is pure crypto, so it runs before the lock. Re-read the
  // list under a row lock: a racing enrol, login counter write or unenrol that
  // committed since the first read is merged, never overwritten, and a removed
  // passkey cannot be written back. The add-a-factor gate runs here too, on the
  // locked row: the router's unlocked check is only a fast refusal, and two
  // parallel password-only first-factor enrolments would otherwise both pass it.
  await transaction(sql, async (tx) => {
    const locked = await tx<Array<{ totp_secret: string | null; webauthn_creds: unknown }>>`
      SELECT totp_secret, webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE
    `;
    if (!locked[0]) throw new EnrollPasskeyError('User not found', 'auth.not_found');
    checkMayAddFactor(locked[0], actor);
    const existing = asCreds(locked[0].webauthn_creds);
    if (existing.some((c) => c.credentialId === stored.credentialId)) {
      throw new EnrollPasskeyError('That authenticator is already registered', 'auth.webauthn_invalid');
    }
    // Owner setting; unset states no limit and refuses nothing.
    if (limits.maxPerAccount !== undefined && existing.length >= limits.maxPerAccount) {
      throw new EnrollPasskeyError('Passkey limit reached', 'identity.passkey_limit');
    }
    const next = [...existing, stored];
    await tx`
      UPDATE users
         SET webauthn_creds = ${tx.json(next as never)}, updated_at = now()
       WHERE id = ${userId}
    `;
  });
  return { credentialId: stored.credentialId };
}
