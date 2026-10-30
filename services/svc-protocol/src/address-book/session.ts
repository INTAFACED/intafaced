import { createHmac, timingSafeEqual } from 'node:crypto';
import { isExplicitDevOrTest } from '@intafaced/config';
import { getAddress as toChecksum, verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';

/**
 * THE WALLET SESSION (D-portfolio-wallet-03): how a signed-out visitor proves they own the wallet whose address book
 * they read or change.
 *
 * The same proof the first-signing representation uses (`representation.ts`: the address itself signed a message this
 * service wrote, recovered with viem), made reusable for a few minutes so a person is not asked to sign every row:
 *
 *   1. `challenge` writes an EIP-4361 (sign-in with Ethereum) message for one address, one chain and one origin the owner
 *      lists, with a random nonce and a five-minute expiry, and seals those fields with an HMAC of the server secret. The
 *      service stores nothing: an unauthenticated caller cannot fill a table by asking for challenges.
 *   2. `open` checks the seal and the expiry, rebuilds the exact message from the sealed fields and checks the signature
 *      recovers to the sealed address. Only then does it issue a session token: the address, the chain and an expiry,
 *      sealed with a second key derived from the same secret.
 *   3. Every address book call verifies that token and takes the owning address from it, never from an address the caller
 *      names.
 *
 * EIP-4361 rather than free text so the wallet itself can warn when the page asking is not the domain in the message.
 * Externally owned wallets only: a smart-contract wallet's signature does not recover and is refused here, as it is for
 * the representation. This is not an on-chain session key (`session/spec.ts`) and grants nothing on any chain.
 *
 * The secret, the session lifetime and the origins are owner settings with no default. Any of them blank refuses
 * `protocol.wallet_session_unset`. A secret labelled TEST (the local test stack's) refuses to boot outside dev or test.
 */

export const WALLET_SESSION_UNSET = 'protocol.wallet_session_unset' as const;
export const WALLET_SESSION_ORIGIN_UNLISTED = 'protocol.wallet_session_origin_unlisted' as const;
export const WALLET_CHALLENGE_INVALID = 'protocol.wallet_challenge_invalid' as const;
export const WALLET_SIGNATURE_NOT_OWNER = 'protocol.wallet_signature_not_owner' as const;
export const WALLET_SESSION_INVALID = 'protocol.wallet_session_invalid' as const;

export type WalletSessionRefusalCode =
  | typeof WALLET_SESSION_UNSET
  | typeof WALLET_SESSION_ORIGIN_UNLISTED
  | typeof WALLET_CHALLENGE_INVALID
  | typeof WALLET_SIGNATURE_NOT_OWNER
  | typeof WALLET_SESSION_INVALID;

export class WalletSessionRefusedError extends Error {
  constructor(
    readonly code: WalletSessionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletSessionRefusedError';
  }
}

/** How long a challenge waits for its signature: an engineering bound, the same as svc-identity's wallet challenge. */
export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** The shortest secret accepted: 32 characters, as every other HMAC secret on the platform. */
export const WALLET_SESSION_SECRET_MIN = 32;

const STATEMENT = 'Open your INTAFACED wallet address book. This proves you own this address. It grants no permission and moves no funds.';

export interface WalletSessionSetting {
  readonly secret: string;
  readonly ttlSeconds: number;
  /** The page origins messages are written for, as `URL.origin` strings. */
  readonly origins: readonly string[];
}

/**
 * Read once at boot. Null while any of the three is blank. A malformed origin, a short secret or a TEST secret outside
 * the raw APP_ENV `dev` / `test` refuses to boot, so a misconfiguration never reaches a person as a working page.
 */
export function walletSessionFromSetting(
  secret: string | undefined,
  ttlSeconds: number | undefined,
  origins: string | undefined,
  rawAppEnv: string | undefined,
): WalletSessionSetting | null {
  const s = secret?.trim() ?? '';
  const listed = (origins ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!s || ttlSeconds === undefined || listed.length === 0) return null;
  if (s.length < WALLET_SESSION_SECRET_MIN)
    throw new Error(`PROTOCOL_WALLET_SESSION_SECRET must be at least ${WALLET_SESSION_SECRET_MIN} characters. Refusing to boot.`);
  if (/^test/i.test(s) && !isExplicitDevOrTest(rawAppEnv))
    throw new Error(
      `PROTOCOL_WALLET_SESSION_SECRET is a TEST secret but APP_ENV=${rawAppEnv ?? '(unset)'} is not the local test stack (APP_ENV must be exactly "dev" or "test"). Refusing to boot.`,
    );
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400)
    throw new Error('PROTOCOL_WALLET_SESSION_TTL_SECONDS must be a whole number of seconds from 60 to 86400. Refusing to boot.');
  const parsed = listed.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`PROTOCOL_WALLET_SESSION_ORIGINS has "${entry}", which is not an origin. Refusing to boot.`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== entry.replace(/\/$/, ''))
      throw new Error(`PROTOCOL_WALLET_SESSION_ORIGINS has "${entry}", which is not a bare http(s) origin. Refusing to boot.`);
    return url.origin;
  });
  return { secret: s, ttlSeconds, origins: parsed };
}

function requireSetting(setting: WalletSessionSetting | null): WalletSessionSetting {
  if (!setting)
    throw new WalletSessionRefusedError(
      WALLET_SESSION_UNSET,
      'Wallet sessions are not configured (secret, lifetime or origins unset), so the address book cannot be opened.',
    );
  return setting;
}

// ── Sealing ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Purpose = 'challenge' | 'session';
/** One key per purpose, derived from the secret, so a challenge can never be presented as a session or the reverse. */
function key(secret: string, purpose: Purpose): Buffer {
  return createHmac('sha256', secret).update(`intafaced.protocol.wallet-${purpose}.v1`).digest();
}
function seal(secret: string, purpose: Purpose, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', key(secret, purpose)).update(body).digest('base64url');
  return `v1.${body}.${mac}`;
}
/** The payload when the seal checks out, else null. Never throws on caller input. */
function unseal(secret: string, purpose: Purpose, token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, body, mac] = parts as [string, string, string];
  const expected = createHmac('sha256', key(secret, purpose)).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Challenge ────────────────────────────────────────────────────────────────────────────────────────────────────

interface ChallengeFields {
  readonly address: Address;
  readonly chainId: number;
  readonly origin: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** The exact message the wallet signs, rebuilt the same way from the same sealed fields. */
export function walletSessionMessage(fields: ChallengeFields): string {
  const origin = new URL(fields.origin);
  return createSiweMessage({
    domain: origin.host,
    address: fields.address,
    statement: STATEMENT,
    uri: origin.origin,
    version: '1',
    chainId: fields.chainId,
    nonce: fields.nonce,
    issuedAt: new Date(fields.issuedAt),
    expirationTime: new Date(fields.expiresAt),
  });
}

export interface WalletChallenge {
  readonly message: string;
  readonly challenge: string;
  readonly expiresAt: Date;
}

export function issueWalletChallenge(
  setting: WalletSessionSetting | null,
  chainId: number,
  input: { address: string; origin: string },
  now: Date = new Date(),
): WalletChallenge {
  const current = requireSetting(setting);
  let origin: string;
  try {
    origin = new URL(input.origin).origin;
  } catch {
    origin = '';
  }
  if (!origin || !current.origins.includes(origin))
    throw new WalletSessionRefusedError(WALLET_SESSION_ORIGIN_UNLISTED, 'Wallet messages are not written for this page’s origin.');
  const fields: ChallengeFields = {
    address: toChecksum(input.address),
    chainId,
    origin,
    nonce: generateSiweNonce(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + WALLET_CHALLENGE_TTL_MS,
  };
  const challenge = seal(current.secret, 'challenge', {
    a: fields.address,
    c: fields.chainId,
    o: fields.origin,
    n: fields.nonce,
    i: fields.issuedAt,
    e: fields.expiresAt,
  });
  return { message: walletSessionMessage(fields), challenge, expiresAt: new Date(fields.expiresAt) };
}

function readChallenge(secret: string, token: string): ChallengeFields | null {
  const p = unseal(secret, 'challenge', token);
  if (!p) return null;
  const { a, c, o, n, i, e } = p;
  if (typeof a !== 'string' || typeof c !== 'number' || typeof o !== 'string' || typeof n !== 'string') return null;
  if (typeof i !== 'number' || typeof e !== 'number') return null;
  return { address: a as Address, chainId: c, origin: o, nonce: n, issuedAt: i, expiresAt: e };
}

// ── Session ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WalletSession {
  readonly session: string;
  readonly address: Address;
  readonly expiresAt: Date;
}

/** Exchanges a signed challenge for a session token. Refuses anything but the sealed address's own signature. */
export async function openWalletSession(
  setting: WalletSessionSetting | null,
  chainId: number,
  input: { challenge: string; signature: string },
  now: Date = new Date(),
): Promise<WalletSession> {
  const current = requireSetting(setting);
  const fields = readChallenge(current.secret, input.challenge);
  // The origin is checked again: an origin the owner has since removed no longer opens sessions.
  if (!fields || fields.chainId !== chainId || now.getTime() >= fields.expiresAt || !current.origins.includes(fields.origin))
    throw new WalletSessionRefusedError(WALLET_CHALLENGE_INVALID, 'This sign-in message is not valid any more. Ask for a new one.');
  let verified = false;
  try {
    verified = await verifyMessage({
      address: fields.address,
      message: walletSessionMessage(fields),
      signature: input.signature as Hex,
    });
  } catch {
    verified = false;
  }
  if (!verified) throw new WalletSessionRefusedError(WALLET_SIGNATURE_NOT_OWNER, 'The signature does not come from this wallet address.');
  const expiresAt = now.getTime() + current.ttlSeconds * 1000;
  const session = seal(current.secret, 'session', { a: fields.address, c: chainId, i: now.getTime(), e: expiresAt });
  return { session, address: fields.address, expiresAt: new Date(expiresAt) };
}

/** The address a session token proves. Refuses a token that is altered, for another chain or expired. */
export function walletSessionOwner(setting: WalletSessionSetting | null, chainId: number, token: string, now: Date = new Date()): Address {
  const current = requireSetting(setting);
  const p = unseal(current.secret, 'session', token);
  const invalid = new WalletSessionRefusedError(WALLET_SESSION_INVALID, 'Your wallet session ended. Sign again to open your address book.');
  if (!p || typeof p.a !== 'string' || typeof p.e !== 'number' || p.c !== chainId) throw invalid;
  if (now.getTime() >= p.e) throw invalid;
  try {
    return toChecksum(p.a);
  } catch {
    throw invalid;
  }
}
