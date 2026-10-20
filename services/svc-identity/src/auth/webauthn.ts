import { createHash, createHmac, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { verifyAuthenticationResponse as verifyAssertionWithLibrary } from '@simplewebauthn/server';
import type { Sql } from 'postgres';
import { decodeCbor, decodeCborItem, encodeCbor, mapGet, type CborValue } from './cbor.js';

/**
 * WebAuthn (W3C Level 2) — registration + assertion, ES256 only.
 *
 * Registration is parsed here (attestation `none`, ES256 only). Assertion
 * verification — ASN.1 DER signature decoding, RP ID hash, origin, user
 * presence/verification flags and the signature counter — is delegated to the
 * maintained `@simplewebauthn/server` library. The earlier hand-rolled
 * verifier read the signature as raw r||s (IEEE P1363), but every real
 * authenticator emits ASN.1 DER for ES256, so it refused real passkeys.
 * We keep strict pre-checks (typed error codes, key policy) in front of the
 * library. ES256 (P-256) is the only algorithm accepted; other algs are
 * refused, deliberately.
 *
 * §9: TOTP + WebAuthn are both required. This is the WebAuthn half.
 */

export interface WebAuthnConfig {
  /** Relying Party ID — usually the registrable domain, e.g. `intafaced.com`. */
  rpID: string;
  rpName: string;
  /** Expected origin(s) on clientDataJSON, e.g. `https://app.intafaced.com`. */
  origin: string | readonly string[];
  /** Challenge lifetime. Default 5 minutes. */
  challengeTtlMs?: number;
}

export interface StoredWebAuthnCredential {
  /** Base64url credential id. */
  credentialId: string;
  /** Base64url COSE public key bytes. */
  publicKey: string;
  /** Signature counter from the authenticator. Cloned devices reset this. */
  counter: number;
  transports?: string[];
  createdAt: string;
}

export interface RegistrationOptionsJSON {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout: number;
  excludeCredentials: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  authenticatorSelection: {
    residentKey: 'preferred';
    userVerification: 'required';
    requireResidentKey: false;
  };
  attestation: 'none';
}

export interface AuthenticationOptionsJSON {
  challenge: string;
  timeout: number;
  rpId: string;
  allowCredentials: Array<{ type: 'public-key'; id: string; transports?: string[] }>;
  userVerification: 'required';
}

/** Wire shape from `navigator.credentials.create()`. */
export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  clientExtensionResults?: Record<string, unknown>;
}

/** Wire shape from `navigator.credentials.get()`. */
export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
  clientExtensionResults?: Record<string, unknown>;
}

const ES256 = -7;
const CHALLENGE_BYTES = 32;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 60_000;

// ── base64url ────────────────────────────────────────────────────────────────

export function b64urlEncode(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

// ── challenge store ──────────────────────────────────────────────────────────

export type ChallengeKind = 'registration' | 'authentication' | 'step-up';

export interface ChallengeEntry {
  challenge: string;
  userId: string | null;
  kind: ChallengeKind;
  expiresAt: number;
}

/**
 * Ceremony challenge port — put once, take once, refuse after TTL.
 *
 * Production uses {@link SqlChallengeStore} (Postgres) so register-on-pod-A /
 * verify-on-pod-B works. Pure unit tests keep the in-memory {@link ChallengeStore}.
 */
export interface ChallengeStorePort {
  put(kind: ChallengeKind, challenge: string, userId: string | null, ttlMs?: number): Promise<void>;
  take(challenge: string, kind: ChallengeKind): Promise<ChallengeEntry | null>;
}

/**
 * In-process challenge store (single pod / pure unit tests).
 *
 * Multi-instance deploys must use {@link SqlChallengeStore} — an in-process
 * Map is invisible across pods, so verify fails closed with "missing challenge".
 */
export class ChallengeStore implements ChallengeStorePort {
  private readonly entries = new Map<string, ChallengeEntry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  async put(kind: ChallengeKind, challenge: string, userId: string | null, ttlMs: number = this.ttlMs): Promise<void> {
    this.prune();
    this.entries.set(challenge, {
      challenge,
      userId,
      kind,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async take(challenge: string, kind: ChallengeKind): Promise<ChallengeEntry | null> {
    this.prune();
    const entry = this.entries.get(challenge);
    if (!entry) return null;
    this.entries.delete(challenge);
    if (entry.kind !== kind) return null;
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  /** Test helper — current size after prune. */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }
}

/**
 * Postgres-backed challenge store — shared across identity pods.
 *
 * Table: identity.webauthn_challenges (migration 0011). take() is single-use
 * (DELETE … RETURNING). Expired rows are pruned on put/take and never accepted.
 */
export class SqlChallengeStore implements ChallengeStorePort {
  constructor(
    private readonly sql: Sql,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async put(kind: ChallengeKind, challenge: string, userId: string | null, ttlMs: number = this.ttlMs): Promise<void> {
    await this.prune();
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.sql`
      INSERT INTO webauthn_challenges (challenge, kind, user_id, expires_at)
      VALUES (${challenge}, ${kind}, ${userId}, ${expiresAt})
      ON CONFLICT (challenge) DO UPDATE SET
        kind = EXCLUDED.kind,
        user_id = EXCLUDED.user_id,
        expires_at = EXCLUDED.expires_at
    `;
  }

  async take(challenge: string, kind: ChallengeKind): Promise<ChallengeEntry | null> {
    await this.prune();
    // Consume first (single-use), then validate kind + expiry — matches in-memory.
    const rows = await this.sql<Array<{ challenge: string; kind: ChallengeKind; user_id: string | null; expires_at: Date }>>`
      DELETE FROM webauthn_challenges
       WHERE challenge = ${challenge}
      RETURNING challenge, kind, user_id, expires_at
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.kind !== kind) return null;
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime();
    if (expiresAt < Date.now()) return null;
    return {
      challenge: row.challenge,
      kind: row.kind,
      userId: row.user_id,
      expiresAt,
    };
  }

  private async prune(): Promise<void> {
    await this.sql`DELETE FROM webauthn_challenges WHERE expires_at < now()`;
  }
}

export { DEFAULT_TTL_MS as CHALLENGE_DEFAULT_TTL_MS };

// ── options ──────────────────────────────────────────────────────────────────

export function generateChallenge(): string {
  return b64urlEncode(randomBytes(CHALLENGE_BYTES));
}

export function createRegistrationOptions(
  config: WebAuthnConfig,
  user: { id: string; name: string; displayName: string },
  existing: readonly StoredWebAuthnCredential[],
  challenge: string,
): RegistrationOptionsJSON {
  return {
    challenge,
    rp: { name: config.rpName, id: config.rpID },
    user: {
      // WebAuthn wants an opaque user handle — we use the uuid as utf8 bytes, base64url'd.
      id: b64urlEncode(Buffer.from(user.id, 'utf8')),
      name: user.name,
      displayName: user.displayName,
    },
    pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
    timeout: TIMEOUT_MS,
    excludeCredentials: existing.map((c) => ({
      type: 'public-key' as const,
      id: c.credentialId,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      // Passwordless session issues mfa:true — require UV, not mere presence (L2-WA-UV).
      userVerification: 'required',
      requireResidentKey: false,
    },
    attestation: 'none',
  };
}

/** Fewest and most credential ids a sign-in answer lists for an account that cannot sign in. */
export const DECOY_COUNT_MIN = 1;
export const DECOY_COUNT_MAX = 3;
/** Byte lengths real credential ids come in (platform authenticators 32, security keys 64). */
const DECOY_ID_BYTES = [32, 64] as const;

/**
 * Credential ids to list for an identifier that cannot sign in with a passkey (unknown, frozen, or no passkey), so the answer does
 * not tell a stranger which identifiers are accounts. Derived from the server secret and the normalised identifier only: the
 * same identifier always gets the same ids, and nothing is stored. Count 1 to 3 and each id 32 or 64 bytes, like real ones.
 */
export function decoyCredentialIds(secret: string, identifier: string): string[] {
  const key = createHmac('sha256', secret).update('webauthn-decoy:v1').digest();
  const normalised = identifier.trim().toLowerCase();
  const head = createHmac('sha256', key).update(`count:${normalised}`).digest();
  const count = DECOY_COUNT_MIN + (head[0]! % (DECOY_COUNT_MAX - DECOY_COUNT_MIN + 1));
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const block = Buffer.concat([
      createHmac('sha256', key).update(`id:${i}:a:${normalised}`).digest(),
      createHmac('sha256', key).update(`id:${i}:b:${normalised}`).digest(),
    ]);
    ids.push(b64urlEncode(block.subarray(0, DECOY_ID_BYTES[block[63]! % DECOY_ID_BYTES.length]!)));
  }
  return ids;
}

export function createAuthenticationOptions(
  config: WebAuthnConfig,
  allow: readonly StoredWebAuthnCredential[],
  challenge: string,
): AuthenticationOptionsJSON {
  return {
    challenge,
    timeout: TIMEOUT_MS,
    rpId: config.rpID,
    allowCredentials: allow.map((c) => ({
      type: 'public-key' as const,
      id: c.credentialId,
      ...(c.transports ? { transports: c.transports } : {}),
    })),
    // Passwordless login: UV required (L2-WA-UV).
    userVerification: 'required',
  };
}

// ── verification ─────────────────────────────────────────────────────────────

export class WebAuthnError extends Error {
  constructor(
    message: string,
    readonly code: 'webauthn.invalid' | 'webauthn.challenge' | 'webauthn.origin' | 'webauthn.counter',
  ) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

function expectedOrigins(config: WebAuthnConfig): Set<string> {
  return new Set(Array.isArray(config.origin) ? config.origin : [config.origin]);
}

function parseClientData(
  clientDataJSONB64: string,
  expected: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origins: Set<string> },
): void {
  let parsed: { type?: string; challenge?: string; origin?: string };
  try {
    parsed = JSON.parse(b64urlDecode(clientDataJSONB64).toString('utf8')) as typeof parsed;
  } catch {
    throw new WebAuthnError('clientDataJSON is not valid JSON', 'webauthn.invalid');
  }
  if (parsed.type !== expected.type) {
    throw new WebAuthnError(`clientData type was ${parsed.type}, expected ${expected.type}`, 'webauthn.invalid');
  }
  if (parsed.challenge !== expected.challenge) {
    throw new WebAuthnError('challenge mismatch', 'webauthn.challenge');
  }
  if (!parsed.origin || !expected.origins.has(parsed.origin)) {
    throw new WebAuthnError(`origin ${parsed.origin ?? '(missing)'} is not allowed`, 'webauthn.origin');
  }
}

function rpIdHash(rpID: string): Buffer {
  return createHash('sha256').update(rpID).digest();
}

interface AuthData {
  flags: number;
  counter: number;
  credentialId?: Buffer;
  publicKeyCose?: Buffer;
}

function validateAuthenticatorExtensions(bytes: Buffer): void {
  let extensions: CborValue;
  try {
    extensions = decodeCbor(bytes);
  } catch (err) {
    throw new WebAuthnError(`authenticator extensions are not valid CBOR: ${(err as Error).message}`, 'webauthn.invalid');
  }
  if (!(extensions instanceof Map) || [...extensions.keys()].some((key) => typeof key !== 'string')) {
    throw new WebAuthnError('authenticator extensions must be a text-keyed map', 'webauthn.invalid');
  }
}

function parseAuthData(authData: Buffer, expectAttested: boolean): AuthData {
  if (authData.length < 37) throw new WebAuthnError('authenticatorData too short', 'webauthn.invalid');

  const flags = authData[32]!;
  const counter = authData.readUInt32BE(33);
  const up = (flags & 0x01) !== 0;
  const uv = (flags & 0x04) !== 0;
  const at = (flags & 0x40) !== 0;
  const ed = (flags & 0x80) !== 0;

  if (!up) throw new WebAuthnError('user presence flag not set', 'webauthn.invalid');
  // Passwordless path marks the session MFA-complete — refuse presence-only
  // authenticators that never verified the user (L2-WA-UV).
  if (!uv) throw new WebAuthnError('user verification flag not set', 'webauthn.invalid');

  let offset = 37;
  let credentialId: Buffer | undefined;
  let publicKeyCose: Buffer | undefined;
  if (expectAttested) {
    if (!at) throw new WebAuthnError('attested credential data missing', 'webauthn.invalid');
    // aaguid (16) + credIdLen (2) + credId + cose key
    if (authData.length < 37 + 18) throw new WebAuthnError('attested credential data truncated', 'webauthn.invalid');
    const credIdLen = authData.readUInt16BE(37 + 16);
    const credIdStart = 37 + 18;
    const credIdEnd = credIdStart + credIdLen;
    if (authData.length < credIdEnd + 1) throw new WebAuthnError('credential id truncated', 'webauthn.invalid');
    credentialId = authData.subarray(credIdStart, credIdEnd);
    // AT carries one COSE item, followed by the ED extension item when present.
    // Its byte boundary comes from decoding, never from a re-encoded length.
    try {
      const item = decodeCborItem(authData.subarray(credIdEnd));
      if (!(item.value instanceof Map)) throw new Error('COSE key is not a map');
      offset = credIdEnd + item.bytesRead;
      publicKeyCose = authData.subarray(credIdEnd, offset);
    } catch (err) {
      throw new WebAuthnError(`COSE key is not valid CBOR: ${(err as Error).message}`, 'webauthn.invalid');
    }
  } else if (at) {
    throw new WebAuthnError('attested credential data is not valid in an assertion', 'webauthn.invalid');
  }

  if (ed) validateAuthenticatorExtensions(authData.subarray(offset));
  else if (offset !== authData.length) throw new WebAuthnError('authenticatorData has trailing bytes without ED', 'webauthn.invalid');
  return { flags, counter, credentialId, publicKeyCose };
}

function coseEc2ToKey(coseBytes: Buffer, legacyStoredExtensions = false): { key: KeyObject; alg: number } {
  let decoded: CborValue;
  try {
    if (legacyStoredExtensions) {
      // Older registration stored the key plus ED bytes together. Read only
      // this historical shape: one key and at most one complete extension map.
      // The suffix grants no authority and the stored credential is not rewritten.
      const item = decodeCborItem(coseBytes);
      decoded = item.value;
      if (item.bytesRead !== coseBytes.length) validateAuthenticatorExtensions(coseBytes.subarray(item.bytesRead));
    } else {
      decoded = decodeCbor(coseBytes);
    }
  } catch (err) {
    throw new WebAuthnError(`COSE key is not valid CBOR: ${(err as Error).message}`, 'webauthn.invalid');
  }
  if (!(decoded instanceof Map)) throw new WebAuthnError('COSE key is not a map', 'webauthn.invalid');

  const kty = mapGet(decoded, 1);
  const alg = mapGet(decoded, 3);
  const crv = mapGet(decoded, -1);
  const x = mapGet(decoded, -2);
  const y = mapGet(decoded, -3);

  if (kty !== 2) throw new WebAuthnError(`unsupported COSE kty ${String(kty)}`, 'webauthn.invalid');
  if (alg !== ES256) throw new WebAuthnError(`unsupported COSE alg ${String(alg)}; only ES256 is accepted`, 'webauthn.invalid');
  if (crv !== 1) throw new WebAuthnError(`unsupported COSE crv ${String(crv)}; only P-256 is accepted`, 'webauthn.invalid');
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new WebAuthnError('COSE EC2 key missing x/y', 'webauthn.invalid');
  }
  if (x.length !== 32 || y.length !== 32) {
    throw new WebAuthnError('COSE EC2 coordinates must be 32 bytes', 'webauthn.invalid');
  }

  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64urlEncode(x),
      y: b64urlEncode(y),
    },
    format: 'jwk',
  });

  return { key, alg: ES256 };
}

export function verifyRegistrationResponse(
  config: WebAuthnConfig,
  expectedChallenge: string,
  response: RegistrationResponseJSON,
): StoredWebAuthnCredential {
  if (response.type !== 'public-key') throw new WebAuthnError('credential type must be public-key', 'webauthn.invalid');

  parseClientData(response.response.clientDataJSON, {
    type: 'webauthn.create',
    challenge: expectedChallenge,
    origins: expectedOrigins(config),
  });

  let attestation: CborValue;
  try {
    attestation = decodeCbor(b64urlDecode(response.response.attestationObject));
  } catch (err) {
    throw new WebAuthnError(`attestationObject is not valid CBOR: ${(err as Error).message}`, 'webauthn.invalid');
  }
  if (!(attestation instanceof Map)) throw new WebAuthnError('attestationObject is not a map', 'webauthn.invalid');

  const fmt = mapGet(attestation, 'fmt');
  // We request attestation: 'none'. Accept only that — packed/tpm/etc. would
  // need a trust store we do not maintain yet.
  if (fmt !== 'none') throw new WebAuthnError(`attestation fmt ${String(fmt)} is not accepted`, 'webauthn.invalid');

  const authDataRaw = mapGet(attestation, 'authData');
  if (!(authDataRaw instanceof Uint8Array)) throw new WebAuthnError('authData missing', 'webauthn.invalid');
  const authData = Buffer.from(authDataRaw);

  const expectedRpHash = rpIdHash(config.rpID);
  if (!authData.subarray(0, 32).equals(expectedRpHash)) {
    throw new WebAuthnError('rpIdHash mismatch', 'webauthn.invalid');
  }

  const parsed = parseAuthData(authData, true);
  if (!parsed.credentialId || !parsed.publicKeyCose) {
    throw new WebAuthnError('credential missing from authData', 'webauthn.invalid');
  }

  // Validate the public key is ES256 and importable.
  coseEc2ToKey(Buffer.from(parsed.publicKeyCose));

  const credentialId = b64urlEncode(parsed.credentialId);
  if (credentialId !== response.id && credentialId !== response.rawId) {
    // Some clients send id as base64url of rawId — both should match the authData id.
    // Accept if either wire field matches; reject otherwise.
    const rawMatch = b64urlEncode(b64urlDecode(response.rawId)) === credentialId;
    const idMatch = b64urlEncode(b64urlDecode(response.id)) === credentialId;
    if (!rawMatch && !idMatch) {
      throw new WebAuthnError('credential id does not match authenticatorData', 'webauthn.invalid');
    }
  }

  return {
    credentialId,
    publicKey: b64urlEncode(parsed.publicKeyCose),
    counter: parsed.counter,
    transports: response.response.transports,
    createdAt: new Date().toISOString(),
  };
}

export async function verifyAuthenticationResponse(
  config: WebAuthnConfig,
  expectedChallenge: string,
  credential: StoredWebAuthnCredential,
  response: AuthenticationResponseJSON,
): Promise<{ newCounter: number }> {
  if (response.type !== 'public-key') throw new WebAuthnError('credential type must be public-key', 'webauthn.invalid');

  const responseId = b64urlEncode(b64urlDecode(response.id));
  if (responseId !== credential.credentialId) {
    throw new WebAuthnError('credential id does not match stored credential', 'webauthn.invalid');
  }

  // Strict pre-checks keep the typed error codes callers rely on. The library
  // below re-checks all of them and is the authority for the signature.
  parseClientData(response.response.clientDataJSON, {
    type: 'webauthn.get',
    challenge: expectedChallenge,
    origins: expectedOrigins(config),
  });

  const authData = b64urlDecode(response.response.authenticatorData);
  if (!authData.subarray(0, 32).equals(rpIdHash(config.rpID))) {
    throw new WebAuthnError('rpIdHash mismatch', 'webauthn.invalid');
  }

  const parsed = parseAuthData(authData, false);

  // A zero that stays zero is allowed (some platform authenticators never
  // increment); a counter that goes backwards or stalls is a cloned authenticator.
  if (credential.counter > 0 && parsed.counter <= credential.counter) {
    throw new WebAuthnError('authenticator counter did not advance', 'webauthn.counter');
  }

  // Enforce the ES256-only key policy, and hand the library a canonical COSE
  // key (older rows may carry a trailing extension map after the key).
  const { key } = coseEc2ToKey(b64urlDecode(credential.publicKey), true);
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  const canonicalCose = coseKeyFromJwk(jwk);

  let verified: boolean;
  try {
    const result = await verifyAssertionWithLibrary({
      response: {
        id: responseId,
        rawId: responseId,
        type: 'public-key',
        response: {
          clientDataJSON: response.response.clientDataJSON,
          authenticatorData: response.response.authenticatorData,
          signature: response.response.signature,
          ...(response.response.userHandle ? { userHandle: response.response.userHandle } : {}),
        },
        clientExtensionResults: {},
      },
      expectedChallenge,
      expectedOrigin: [...expectedOrigins(config)],
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(canonicalCose),
        counter: credential.counter,
      },
    });
    verified = result.verified;
  } catch (err) {
    throw new WebAuthnError(`assertion rejected: ${err instanceof Error ? err.message : 'verification failed'}`, 'webauthn.invalid');
  }
  if (!verified) throw new WebAuthnError('signature verification failed', 'webauthn.invalid');

  return { newCounter: parsed.counter };
}

// ── test/authenticator helpers (also used by the service tests) ──────────────

/** Build a COSE_Key for an ES256 P-256 public JWK. */
export function coseKeyFromJwk(jwk: { x: string; y: string }): Buffer {
  const map = new Map<CborValue, CborValue>([
    [1, 2],
    [3, ES256],
    [-1, 1],
    [-2, new Uint8Array(b64urlDecode(jwk.x!))],
    [-3, new Uint8Array(b64urlDecode(jwk.y!))],
  ]);
  return Buffer.from(encodeCbor(map));
}

export function buildAuthenticatorData(opts: {
  rpID: string;
  counter: number;
  /** When set, AT flag is set and credential data is included. */
  credential?: { id: Buffer; publicKeyCose: Buffer };
  userPresent?: boolean;
  userVerified?: boolean;
}): Buffer {
  const rpHash = rpIdHash(opts.rpID);
  let flags = 0;
  if (opts.userPresent !== false) flags |= 0x01;
  if (opts.userVerified !== false) flags |= 0x04;
  if (opts.credential) flags |= 0x40;

  const header = Buffer.alloc(37);
  rpHash.copy(header, 0);
  header[32] = flags;
  header.writeUInt32BE(opts.counter >>> 0, 33);

  if (!opts.credential) return header;

  const aaguid = Buffer.alloc(16);
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(opts.credential.id.length);
  return Buffer.concat([header, aaguid, idLen, opts.credential.id, opts.credential.publicKeyCose]);
}

export function buildClientDataJSON(opts: { type: 'webauthn.create' | 'webauthn.get'; challenge: string; origin: string }): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: opts.type,
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }),
    'utf8',
  );
}
