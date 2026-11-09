/**
 * THE ORDER SESSION (D-limit-dca-01, ENGINE SIG-1..SIG-3): how a wallet proves it owns the orders it places, edits and
 * cancels, without an INTAFACED account.
 *
 *   1. `challenge` writes an EIP-712 `OrderSession` for one wallet and one chain: the scope in words, when the session
 *      ends and the order cap schedule it is bound to, with a random nonce. The fields are sealed with an HMAC of the
 *      owner's secret; nothing is stored, so an unauthenticated caller cannot fill a file by asking for challenges.
 *   2. `verify` checks the seal and the challenge's expiry, rebuilds the exact typed data from the sealed fields and
 *      checks the signature recovers to the sealed wallet. Then it spends the nonce, once: the same challenge sent again
 *      refuses `dex.auth.challenge_replayed`, so a signature intercepted on its way here opens nothing. Only then does it
 *      issue an access token and a refresh token, both carrying one session id, both revocable.
 *   3. Every order call verifies the access token and takes the maker from it, never from an address the caller names.
 *
 * The signature proves ownership and moves no funds. Externally owned wallets only: a smart-contract wallet's signature
 * does not recover here and is refused (`dex.auth.signature_not_owner`); its ERC-1271 check needs the chain port and is
 * not wired in this file.
 *
 * The secret, both lifetimes and the order cap schedule are owner settings with no default. A blank secret refuses
 * `dex.auth.session_unset`, a blank lifetime `dex.auth.lifetime_unset`, a blank cap schedule `dex.order.cap_unset`. A
 * secret labelled TEST refuses to boot outside dev or test.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isExplicitDevOrTest } from '@intafaced/config';
import type { DexOrderCap, DexTypedData } from '@intafaced/contracts/protocol-dex-orders';
import { getAddress, hashTypedData, recoverAddress, type Address, type Hex } from 'viem';
import type { SessionStore } from './session-store.js';

export const authCodes = {
  sessionUnset: 'dex.auth.session_unset',
  lifetimeUnset: 'dex.auth.lifetime_unset',
  capUnset: 'dex.order.cap_unset',
  challengeInvalid: 'dex.auth.challenge_invalid',
  challengeReplayed: 'dex.auth.challenge_replayed',
  signatureNotOwner: 'dex.auth.signature_not_owner',
  unauthenticated: 'dex.auth.unauthenticated',
  forbidden: 'dex.auth.forbidden',
} as const;
export type AuthCode = (typeof authCodes)[keyof typeof authCodes];

export class OrderSessionRefused extends Error {
  constructor(
    readonly code: AuthCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrderSessionRefused';
  }
}
const refuse = (code: AuthCode, message: string): never => {
  throw new OrderSessionRefused(code, message);
};

/** How long a challenge waits for its signature: an engineering bound, as svc-protocol's wallet challenge. */
export const ORDER_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const ORDER_SESSION_SECRET_MIN = 32;
export const ORDER_SESSION_SCOPE =
  'Place, change and cancel orders from this wallet’s order vault, within the cap below. It moves no funds and grants nothing on chain.';

export interface OrderSessionSetting {
  readonly secret: string | undefined;
  readonly accessTtlSeconds: number | undefined;
  readonly refreshTtlSeconds: number | undefined;
  readonly cap: readonly DexOrderCap[] | undefined;
}

/** Boot checks: a short secret, or a TEST secret outside the raw APP_ENV `dev` / `test`, refuses to boot. */
export function checkOrderSessionSetting(setting: OrderSessionSetting, rawAppEnv: string | undefined): OrderSessionSetting {
  const secret = setting.secret?.trim();
  if (secret) {
    if (secret.length < ORDER_SESSION_SECRET_MIN)
      throw new Error(`DEX_AUTH_SECRET must be at least ${ORDER_SESSION_SECRET_MIN} characters. Refusing to boot.`);
    if (/^test/i.test(secret) && !isExplicitDevOrTest(rawAppEnv))
      throw new Error(`DEX_AUTH_SECRET is a TEST secret but APP_ENV=${rawAppEnv ?? '(unset)'} is not dev or test. Refusing to boot.`);
  }
  for (const [name, ttl] of [
    ['DEX_AUTH_ACCESS_TTL_SECONDS', setting.accessTtlSeconds],
    ['DEX_AUTH_REFRESH_TTL_SECONDS', setting.refreshTtlSeconds],
  ] as const)
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 86_400))
      throw new Error(`${name} must be a whole number of seconds from 60 to 2592000. Refusing to boot.`);
  return { ...setting, secret: secret || undefined };
}

interface Ready {
  readonly secret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  readonly cap: readonly DexOrderCap[];
}
function ready(setting: OrderSessionSetting): Ready {
  if (!setting.secret) refuse(authCodes.sessionUnset, 'Order sessions are not configured (secret unset), so no order can be placed.');
  if (setting.accessTtlSeconds === undefined || setting.refreshTtlSeconds === undefined)
    refuse(authCodes.lifetimeUnset, 'The order session lifetime is not published, so no session is written.');
  if (setting.cap === undefined || setting.cap.length === 0)
    refuse(authCodes.capUnset, 'The order cap schedule is not published, so no session is written.');
  return setting as Ready;
}

// ── Sealing ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Purpose = 'challenge' | 'access' | 'refresh';
/** One key per purpose, so a challenge is never a token, and an access token is never a refresh token. */
const key = (secret: string, purpose: Purpose) => createHmac('sha256', secret).update(`intafaced.dex.order-${purpose}.v1`).digest();
function seal(secret: string, purpose: Purpose, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `v1.${body}.${createHmac('sha256', key(secret, purpose)).update(body).digest('base64url')}`;
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

// ── The typed data ────────────────────────────────────────────────────────────────────────────────────────────────

interface ChallengeFields {
  readonly wallet: Address;
  readonly chainId: number;
  readonly nonce: Hex;
  readonly sessionExpiresAt: number;
  readonly challengeExpiresAt: number;
  readonly cap: readonly DexOrderCap[];
}

export const ORDER_SESSION_DOMAIN_NAME = 'INTAFACED order session';

/** The words a wallet shows for the cap: one line per token. */
export function capWords(cap: readonly DexOrderCap[]): string {
  return cap.map((row) => `${row.max} ${row.symbol} open at once`).join('; ');
}

/** The exact EIP-712 document the wallet signs, rebuilt the same way from the same sealed fields. */
export function orderSessionTypedData(fields: ChallengeFields): DexTypedData {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      OrderSession: [
        { name: 'wallet', type: 'address' },
        { name: 'scope', type: 'string' },
        { name: 'cap', type: 'string' },
        { name: 'expiresAt', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'OrderSession',
    domain: { name: ORDER_SESSION_DOMAIN_NAME, version: '1', chainId: fields.chainId },
    message: {
      wallet: fields.wallet,
      scope: ORDER_SESSION_SCOPE,
      cap: capWords(fields.cap),
      // Seconds, as a decimal string: the wallet hashes a uint256 from it.
      expiresAt: String(Math.floor(fields.sessionExpiresAt / 1000)),
      nonce: fields.nonce,
    },
  };
}

function digest(typed: DexTypedData): Hex {
  const { EIP712Domain: _domain, ...types } = typed.types;
  const m = typed.message as { wallet: Address; scope: string; cap: string; expiresAt: string; nonce: Hex };
  return hashTypedData({
    domain: typed.domain,
    types: types as { OrderSession: { name: string; type: string }[] },
    primaryType: 'OrderSession',
    message: { ...m, expiresAt: BigInt(m.expiresAt) },
  });
}

export interface IssuedChallenge {
  readonly challenge: string;
  readonly typedData: DexTypedData;
  readonly scope: string;
  readonly sessionExpiresAt: string;
  readonly cap: DexOrderCap[];
  readonly challengeExpiresAt: string;
}

export interface IssuedSession {
  readonly wallet: Address;
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly scope: string;
  readonly cap: DexOrderCap[];
}

/** Who an access token speaks for. */
export interface OrderPrincipal {
  readonly wallet: string;
  readonly sessionId: string;
  readonly cap: readonly DexOrderCap[];
}

export class OrderSessions {
  constructor(
    private readonly setting: OrderSessionSetting,
    private readonly store: SessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  challenge(input: { address: string; chainId: number }): IssuedChallenge {
    const s = ready(this.setting);
    const at = this.now().getTime();
    const fields: ChallengeFields = {
      wallet: getAddress(input.address),
      chainId: input.chainId,
      nonce: `0x${randomBytes(32).toString('hex')}`,
      sessionExpiresAt: at + s.accessTtlSeconds * 1000,
      challengeExpiresAt: at + ORDER_CHALLENGE_TTL_MS,
      cap: s.cap,
    };
    const challenge = seal(s.secret, 'challenge', {
      w: fields.wallet,
      c: fields.chainId,
      n: fields.nonce,
      s: fields.sessionExpiresAt,
      e: fields.challengeExpiresAt,
      k: fields.cap,
    });
    return {
      challenge,
      typedData: orderSessionTypedData(fields),
      scope: ORDER_SESSION_SCOPE,
      sessionExpiresAt: new Date(fields.sessionExpiresAt).toISOString(),
      cap: [...s.cap],
      challengeExpiresAt: new Date(fields.challengeExpiresAt).toISOString(),
    };
  }

  async verify(input: { challenge: string; signature: string }): Promise<IssuedSession> {
    const s = ready(this.setting);
    const raw = unseal(s.secret, 'challenge', input.challenge);
    const at = this.now().getTime();
    if (
      !raw ||
      typeof raw.w !== 'string' ||
      typeof raw.c !== 'number' ||
      typeof raw.n !== 'string' ||
      typeof raw.s !== 'number' ||
      typeof raw.e !== 'number' ||
      !Array.isArray(raw.k)
    )
      return refuse(authCodes.challengeInvalid, 'This challenge was not written by this service.');
    if (raw.e <= at) return refuse(authCodes.challengeInvalid, 'This challenge has expired. Ask for a new one.');
    const fields: ChallengeFields = {
      wallet: getAddress(raw.w),
      chainId: raw.c,
      nonce: raw.n as Hex,
      sessionExpiresAt: raw.s,
      challengeExpiresAt: raw.e,
      cap: raw.k as DexOrderCap[],
    };
    let recovered: string;
    try {
      recovered = await recoverAddress({ hash: digest(orderSessionTypedData(fields)), signature: input.signature as Hex });
    } catch {
      return refuse(authCodes.signatureNotOwner, 'The signature does not recover to this wallet.');
    }
    if (getAddress(recovered) !== fields.wallet)
      return refuse(authCodes.signatureNotOwner, 'The signature does not recover to this wallet.');
    // Spent once, before any token exists: a second verify of the same challenge opens nothing.
    if (!this.store.spendNonce(fields.nonce, fields.challengeExpiresAt))
      return refuse(authCodes.challengeReplayed, 'This signed challenge was already used. Sign a new order session.');
    return this.issue(
      s,
      fields.wallet,
      `${fields.nonce.slice(2, 18)}${randomBytes(8).toString('hex')}`,
      fields.cap,
      at,
      fields.sessionExpiresAt,
    );
  }

  refresh(refreshToken: string): IssuedSession {
    const s = ready(this.setting);
    const p = this.read(s, 'refresh', refreshToken);
    // A refresh token is spent too: the old pair ends and a new pair carries the same session id.
    if (!this.store.spendNonce(`refresh:${p.jti}`, p.exp))
      return refuse(authCodes.unauthenticated, 'This refresh token was already used. Sign a new order session.');
    // A new pair, never past the end the wallet signed: refreshing cannot stretch the session.
    return this.issue(s, p.wallet as Address, p.sid, p.cap, this.now().getTime(), p.end);
  }

  /** Ends one session: its access and refresh tokens both stop at once. */
  logout(accessToken: string): { revoked: true; wallet: string } {
    const s = ready(this.setting);
    const p = this.read(s, 'access', accessToken);
    this.store.revokeSession(p.sid, p.exp + s.refreshTtlSeconds * 1000);
    return { revoked: true, wallet: p.wallet };
  }

  /** Ends every session this wallet opened so far. */
  logoutAll(accessToken: string): { revoked: true; wallet: string } {
    const s = ready(this.setting);
    const p = this.read(s, 'access', accessToken);
    this.store.revokeWalletBefore(p.wallet, this.now().getTime());
    return { revoked: true, wallet: p.wallet };
  }

  /** The wallet an access token speaks for; anything else refuses `dex.auth.unauthenticated`. */
  principal(accessToken: string | undefined): OrderPrincipal {
    const s = ready(this.setting);
    if (!accessToken) return refuse(authCodes.unauthenticated, 'Sign the order session first.');
    const p = this.read(s, 'access', accessToken);
    return { wallet: p.wallet.toLowerCase(), sessionId: p.sid, cap: p.cap };
  }

  private issue(s: Ready, wallet: Address, sid: string, cap: readonly DexOrderCap[], at: number, end: number): IssuedSession {
    const accessExp = Math.min(at + s.accessTtlSeconds * 1000, end);
    const refreshExp = Math.min(at + s.refreshTtlSeconds * 1000, end);
    const base = { w: wallet, sid, k: cap, iat: at, end };
    return {
      wallet,
      accessToken: seal(s.secret, 'access', { ...base, exp: accessExp }),
      accessExpiresAt: new Date(accessExp).toISOString(),
      refreshToken: seal(s.secret, 'refresh', { ...base, exp: refreshExp, jti: randomBytes(12).toString('hex') }),
      refreshExpiresAt: new Date(refreshExp).toISOString(),
      scope: ORDER_SESSION_SCOPE,
      cap: [...cap],
    };
  }

  private read(s: Ready, purpose: 'access' | 'refresh', token: string) {
    const raw = unseal(s.secret, purpose, token);
    const at = this.now().getTime();
    if (
      !raw ||
      typeof raw.w !== 'string' ||
      typeof raw.sid !== 'string' ||
      typeof raw.exp !== 'number' ||
      typeof raw.iat !== 'number' ||
      typeof raw.end !== 'number' ||
      !Array.isArray(raw.k)
    )
      return refuse(authCodes.unauthenticated, 'This order session token is not valid. Sign a new order session.');
    if (raw.exp <= at) return refuse(authCodes.unauthenticated, 'This order session has ended. Sign a new one.');
    if (this.store.revoked(raw.sid, raw.w, raw.iat)) return refuse(authCodes.unauthenticated, 'This order session was signed out.');
    return {
      wallet: raw.w,
      sid: raw.sid,
      exp: raw.exp,
      end: raw.end,
      jti: typeof raw.jti === 'string' ? raw.jti : '',
      cap: raw.k as DexOrderCap[],
    };
  }
}
