import { getAddress as toChecksum, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';
import type { VenueWalletAction } from '@intafaced/contracts/protocol-venue-wallet';
import {
  WALLET_CHALLENGE_INVALID,
  WALLET_SESSION_ORIGIN_UNLISTED,
  WALLET_SESSION_UNSET,
  WALLET_SIGNATURE_NOT_OWNER,
  seal,
  unseal,
  type WalletSessionSetting,
} from '../address-book/session.js';

/**
 * THE VENUE WALLET CONNECTION (J-wallet-09): a signed-in person connects their own wallet to their INTAFACED account, so
 * a venue account that wallet owns can be funded and traded from it.
 *
 *   1. `issueVenueChallenge` screens the address against the owner's wallet sanctions list and writes an EIP-4361 message
 *      naming INTAFACED, the address, the chain, a fresh nonce and the connection's expiry. The fields, with the person's
 *      id, are sealed with the wallet session secret under their own key purpose (`venue-challenge`), so the service
 *      stores nothing until a signature comes back.
 *   2. `openVenueConnection` checks the seal, the person, the chain, the expiry and the origin, rebuilds the exact message,
 *      checks the signature recovers to the sealed address and screens the address again. The store then spends the nonce
 *      (its business key, `venue-connect:<chainId>:<nonce>`) and writes the connection in one transaction: a signed message
 *      opens one connection once, and a second press renews the same row, never a second connection.
 *   3. `assertVenueConnectionLive` runs before every signed venue action: a wallet that is not connected, expired or
 *      listed since refuses by name, so nothing is asked of the wallet.
 *
 * A connection is an address and its expiry. It holds no key: INTAFACED cannot move the wallet's funds, and every venue
 * action is signed in the wallet. Region blocks run before any of this, in the procedure's jurisdiction guard, on the
 * per-country switch (`INTAFACED_SANCTIONS_REGIONS`, OWNER 237). Nothing here posts to the ledger.
 *
 * Owner settings, no defaults: the wallet session secret and origins (shared with the address book), the connection
 * lifetime and the wallet sanctions list. Any of them blank refuses by name.
 */

export const VENUE_CONNECTION_TTL_UNSET = 'protocol.venue_connection_ttl_unset' as const;
export const WALLET_SANCTIONS_UNSET = 'protocol.wallet_sanctions_unset' as const;
export const WALLET_SANCTIONED = 'protocol.wallet_sanctioned' as const;
export const VENUE_CHALLENGE_USED = 'protocol.venue_challenge_used' as const;
export const VENUE_CONNECTION_NONE = 'protocol.venue_connection_none' as const;
export const VENUE_CONNECTION_EXPIRED = 'protocol.venue_connection_expired' as const;
export const VENUE_UNWIRED = 'protocol.venue_unwired' as const;

export type VenueConnectionRefusalCode =
  | typeof WALLET_SESSION_UNSET
  | typeof WALLET_SESSION_ORIGIN_UNLISTED
  | typeof WALLET_CHALLENGE_INVALID
  | typeof WALLET_SIGNATURE_NOT_OWNER
  | typeof VENUE_CONNECTION_TTL_UNSET
  | typeof WALLET_SANCTIONS_UNSET
  | typeof WALLET_SANCTIONED
  | typeof VENUE_CHALLENGE_USED
  | typeof VENUE_CONNECTION_NONE
  | typeof VENUE_CONNECTION_EXPIRED
  | typeof VENUE_UNWIRED;

export class VenueConnectionRefusedError extends Error {
  constructor(
    readonly code: VenueConnectionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'VenueConnectionRefusedError';
  }
}

/** The longest a challenge waits for its signature: the same five minutes as the wallet session's challenge. */
export const VENUE_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Bounds on the owner's connection lifetime: an engineering range, not a value. */
export const VENUE_CONNECTION_TTL_MIN_SECONDS = 30;
export const VENUE_CONNECTION_TTL_MAX_SECONDS = 30 * 86_400;

/** The word that declares a deliberately empty list, as the region screening list declares it. */
export const WALLET_SANCTIONS_REVIEWED_EMPTY = 'none';

export interface WalletSanctionsList {
  /** Lower-case addresses on the list. Empty only when the owner wrote `none`. */
  readonly addresses: ReadonlySet<string>;
}

/**
 * `PROTOCOL_WALLET_SANCTIONS`, read once at boot: a comma-separated list of EVM addresses, or `none` for a list the owner
 * has reviewed and left empty. Blank is null, and every connect refuses `protocol.wallet_sanctions_unset`: a blank list is
 * not a screened-clean one. An entry that is not an address refuses to boot, so a mistyped entry never matches nothing.
 */
export function walletSanctionsFromSetting(raw: string | undefined): WalletSanctionsList | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  if (text.toLowerCase() === WALLET_SANCTIONS_REVIEWED_EMPTY) return { addresses: new Set() };
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries)
    if (!isAddress(entry, { strict: false }))
      throw new Error(`PROTOCOL_WALLET_SANCTIONS has "${entry}", which is not an EVM address. Refusing to boot.`);
  if (entries.length === 0) return null;
  return { addresses: new Set(entries.map((entry) => entry.toLowerCase())) };
}

/** `PROTOCOL_VENUE_CONNECTION_TTL_SECONDS`, read once at boot. Undefined is null (refuses by name); out of range refuses to boot. */
export function venueConnectionTtlFromSetting(seconds: number | undefined): number | null {
  if (seconds === undefined) return null;
  if (!Number.isInteger(seconds) || seconds < VENUE_CONNECTION_TTL_MIN_SECONDS || seconds > VENUE_CONNECTION_TTL_MAX_SECONDS)
    throw new Error(
      `PROTOCOL_VENUE_CONNECTION_TTL_SECONDS must be a whole number of seconds from ${VENUE_CONNECTION_TTL_MIN_SECONDS} to ${VENUE_CONNECTION_TTL_MAX_SECONDS}. Refusing to boot.`,
    );
  return seconds;
}

/** Screens one address. Throws the named refusal for a blank list or a listed address. */
export function screenWallet(list: WalletSanctionsList | null, address: string): void {
  if (!list)
    throw new VenueConnectionRefusedError(
      WALLET_SANCTIONS_UNSET,
      'The wallet sanctions list is not set, so no wallet can be screened or connected. Nothing was connected.',
    );
  if (list.addresses.has(address.toLowerCase()))
    throw new VenueConnectionRefusedError(
      WALLET_SANCTIONED,
      'This wallet is on the sanctions list, so it cannot be connected or used. Nothing was connected.',
    );
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VenueConnectionRecord {
  readonly userId: string;
  readonly chainId: number;
  readonly address: Address;
  readonly connectedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewVenueConnection {
  readonly userId: string;
  readonly chainId: number;
  readonly address: Address;
  readonly nonce: string;
  readonly connectedAt: Date;
  readonly expiresAt: Date;
}

/** The business key a signed challenge is spent under. */
export const venueConnectKey = (chainId: number, nonce: string) => `venue-connect:${chainId}:${nonce}`;

export interface VenueConnectionStore {
  /**
   * Spends the nonce and writes the connection (a new row, or the same row renewed) in one transaction. Null when the
   * nonce was already spent: nothing is written.
   */
  open(input: NewVenueConnection): Promise<VenueConnectionRecord | null>;
  /** The person's connections on this chain that are not disconnected, newest first. */
  list(userId: string, chainId: number): Promise<VenueConnectionRecord[]>;
  /** The person's connection for this wallet, disconnected or not; null when there has never been one. */
  find(userId: string, chainId: number, address: Address): Promise<VenueConnectionRecord | null>;
  /** Marks the connection disconnected. False when there was none to disconnect. */
  revoke(userId: string, chainId: number, address: Address, at: Date): Promise<boolean>;
}

/** The store the tests use. Same rules as the Postgres one: one row per person, chain and wallet; a nonce spends once. */
export class MemoryVenueConnectionStore implements VenueConnectionStore {
  readonly rows = new Map<string, VenueConnectionRecord>();
  readonly spent = new Set<string>();
  private key = (userId: string, chainId: number, address: string) => `${userId}:${chainId}:${address.toLowerCase()}`;

  async open(input: NewVenueConnection): Promise<VenueConnectionRecord | null> {
    const idem = venueConnectKey(input.chainId, input.nonce);
    if (this.spent.has(idem)) return null;
    this.spent.add(idem);
    const row: VenueConnectionRecord = {
      userId: input.userId,
      chainId: input.chainId,
      address: input.address,
      connectedAt: input.connectedAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.rows.set(this.key(input.userId, input.chainId, input.address), row);
    return row;
  }
  async list(userId: string, chainId: number): Promise<VenueConnectionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && r.chainId === chainId && r.revokedAt === null)
      .sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
  }
  async find(userId: string, chainId: number, address: Address): Promise<VenueConnectionRecord | null> {
    return this.rows.get(this.key(userId, chainId, address)) ?? null;
  }
  async revoke(userId: string, chainId: number, address: Address, at: Date): Promise<boolean> {
    const k = this.key(userId, chainId, address);
    const row = this.rows.get(k);
    if (!row || row.revokedAt !== null) return false;
    this.rows.set(k, { ...row, revokedAt: at });
    return true;
  }
}

// ── Challenge ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VenueConnectionDeps {
  /** Read per call: the chain the service is configured for. */
  chainId: () => number;
  store: VenueConnectionStore;
  /** The wallet session secret and origins (shared with the address book); null while any is blank. */
  session: () => WalletSessionSetting | null;
  /** Seconds a connection lasts; null while the owner has not set it. */
  ttlSeconds: () => number | null;
  /** The owner's wallet sanctions list; null while blank. */
  sanctions: () => WalletSanctionsList | null;
}

interface ChallengeFields {
  readonly userId: string;
  readonly address: Address;
  readonly chainId: number;
  readonly origin: string;
  readonly nonce: string;
  readonly issuedAt: number;
  /** The connection's expiry, stated in the message. */
  readonly expiresAt: number;
}

const statement = (expiresAt: number) =>
  `Connect this wallet to your INTAFACED account for venue trading until ${new Date(expiresAt).toISOString()}. ` +
  'INTAFACED receives no key and cannot move this wallet’s funds; you sign every venue action in this wallet.';

/** The exact message the wallet signs, rebuilt the same way from the same sealed fields. */
export function venueConnectionMessage(fields: ChallengeFields): string {
  const origin = new URL(fields.origin);
  return createSiweMessage({
    domain: origin.host,
    address: fields.address,
    statement: statement(fields.expiresAt),
    uri: origin.origin,
    version: '1',
    chainId: fields.chainId,
    nonce: fields.nonce,
    issuedAt: new Date(fields.issuedAt),
    expirationTime: new Date(fields.expiresAt),
  });
}

function requireSession(setting: WalletSessionSetting | null): WalletSessionSetting {
  if (!setting)
    throw new VenueConnectionRefusedError(
      WALLET_SESSION_UNSET,
      'Wallet messages are not configured (secret or origins unset), so no wallet can be connected.',
    );
  return setting;
}
function requireTtl(seconds: number | null): number {
  if (seconds === null)
    throw new VenueConnectionRefusedError(
      VENUE_CONNECTION_TTL_UNSET,
      'How long a wallet connection lasts is not set, so no wallet can be connected.',
    );
  return seconds;
}

export interface VenueChallenge {
  readonly message: string;
  readonly challenge: string;
  readonly expiresAt: Date;
}

export function issueVenueChallenge(
  deps: VenueConnectionDeps,
  input: { userId: string; address: string; origin: string },
  now: Date = new Date(),
): VenueChallenge {
  const session = requireSession(deps.session());
  const ttl = requireTtl(deps.ttlSeconds());
  let origin: string;
  try {
    origin = new URL(input.origin).origin;
  } catch {
    origin = '';
  }
  if (!origin || !session.origins.includes(origin))
    throw new VenueConnectionRefusedError(WALLET_SESSION_ORIGIN_UNLISTED, 'Wallet messages are not written for this page’s origin.');
  const address = toChecksum(input.address);
  screenWallet(deps.sanctions(), address);
  const fields: ChallengeFields = {
    userId: input.userId,
    address,
    chainId: deps.chainId(),
    origin,
    nonce: generateSiweNonce(),
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + ttl * 1000,
  };
  const challenge = seal(session.secret, 'venue-challenge', {
    u: fields.userId,
    a: fields.address,
    c: fields.chainId,
    o: fields.origin,
    n: fields.nonce,
    i: fields.issuedAt,
    e: fields.expiresAt,
  });
  return { message: venueConnectionMessage(fields), challenge, expiresAt: new Date(fields.expiresAt) };
}

function readChallenge(secret: string, token: string): ChallengeFields | null {
  const p = unseal(secret, 'venue-challenge', token);
  if (!p) return null;
  const { u, a, c, o, n, i, e } = p;
  if (typeof u !== 'string' || typeof a !== 'string' || typeof c !== 'number' || typeof o !== 'string' || typeof n !== 'string')
    return null;
  if (typeof i !== 'number' || typeof e !== 'number') return null;
  return { userId: u, address: a as Address, chainId: c, origin: o, nonce: n, issuedAt: i, expiresAt: e };
}

/** Exchanges a signed challenge for a connection. Refuses anything but the sealed address's own signature, once. */
export async function openVenueConnection(
  deps: VenueConnectionDeps,
  input: { userId: string; challenge: string; signature: string },
  now: Date = new Date(),
): Promise<VenueConnectionRecord> {
  const session = requireSession(deps.session());
  const fields = readChallenge(session.secret, input.challenge);
  const t = now.getTime();
  // Signable for five minutes at most, and never past the connection's own expiry. The origin is checked again: an origin
  // the owner has since removed no longer connects wallets.
  if (
    !fields ||
    fields.userId !== input.userId ||
    fields.chainId !== deps.chainId() ||
    t >= Math.min(fields.expiresAt, fields.issuedAt + VENUE_CHALLENGE_TTL_MS) ||
    !session.origins.includes(fields.origin)
  )
    throw new VenueConnectionRefusedError(WALLET_CHALLENGE_INVALID, 'This connect message is not valid any more. Ask for a new one.');
  let verified = false;
  try {
    verified = await verifyMessage({ address: fields.address, message: venueConnectionMessage(fields), signature: input.signature as Hex });
  } catch {
    verified = false;
  }
  if (!verified) throw new VenueConnectionRefusedError(WALLET_SIGNATURE_NOT_OWNER, 'The signature does not come from this wallet address.');
  // Listed after the message was written: still refused.
  screenWallet(deps.sanctions(), fields.address);
  const opened = await deps.store.open({
    userId: fields.userId,
    chainId: fields.chainId,
    address: fields.address,
    nonce: fields.nonce,
    connectedAt: now,
    expiresAt: new Date(fields.expiresAt),
  });
  if (!opened)
    throw new VenueConnectionRefusedError(
      VENUE_CHALLENGE_USED,
      'This connect message was already used. Connecting again needs a new signature.',
    );
  return opened;
}

export type VenueConnectionStatus = 'live' | 'expired';
export const connectionStatus = (row: VenueConnectionRecord, now: Date): VenueConnectionStatus =>
  now.getTime() < row.expiresAt.getTime() ? 'live' : 'expired';

/**
 * The connection a signed venue action needs, checked before the wallet is asked anything. Refuses a wallet that was never
 * connected or was disconnected, one whose expiry has passed, and one listed since it connected.
 */
export async function assertVenueConnectionLive(
  deps: VenueConnectionDeps,
  input: { userId: string; address: string },
  now: Date = new Date(),
): Promise<VenueConnectionRecord> {
  const address = toChecksum(input.address);
  const row = await deps.store.find(input.userId, deps.chainId(), address);
  if (!row || row.revokedAt !== null)
    throw new VenueConnectionRefusedError(VENUE_CONNECTION_NONE, 'This wallet is not connected to your account. Connect it first.');
  if (connectionStatus(row, now) === 'expired')
    throw new VenueConnectionRefusedError(
      VENUE_CONNECTION_EXPIRED,
      'This wallet’s connection has expired. Sign again in the wallet to connect it before any signed action.',
    );
  screenWallet(deps.sanctions(), row.address);
  return row;
}

/**
 * A signed venue action (deposit, withdraw) before the venue is wired: the connection is checked first, so an expired one
 * refuses by its own name, and a live one refuses `protocol.venue_unwired`. Nothing is asked of the wallet either way.
 */
export async function authorizeVenueAction(
  deps: VenueConnectionDeps,
  input: { userId: string; address: string; action: VenueWalletAction },
  now: Date = new Date(),
): Promise<never> {
  await assertVenueConnectionLive(deps, input, now);
  throw new VenueConnectionRefusedError(
    VENUE_UNWIRED,
    `No venue is connected to this service yet, so the ${input.action} was not started and nothing was asked of your wallet.`,
  );
}
