import { randomBytes } from 'node:crypto';
import { isExplicitDevOrTest } from '@intafaced/config';
import { getAddress as toChecksum, hashMessage, recoverMessageAddress, type Address, type Hex } from 'viem';

/**
 * CONTRACT OWNERSHIP PROOF (D-launch-listing-01).
 *
 * Before a token's info can be updated, whoever asks proves they control the token: they sign a one-time challenge with
 * the wallet the token contract names as its `owner()`. The service issues the challenge (a fresh random nonce, single
 * use, with an expiry), then recovers the signer (an EOA) or asks the owner contract (ERC-1271) and compares it with the
 * owner read from the chain. A proof is stored with the signer, the block it was checked at and the message hash.
 *
 * Nothing here moves value and nothing is held: the service only reads the chain and records what it read. A token whose
 * owner cannot be read is refused (`protocol.listing.owner_unknown`), never guessed. The challenge lifetime is the owner's
 * setting; blank refuses `protocol.listing.challenge_ttl_unset` and no challenge is issued.
 */

export const LISTING_CHALLENGE_TTL_UNSET = 'protocol.listing.challenge_ttl_unset' as const;
export const LISTING_NONCE_UNKNOWN = 'protocol.listing.nonce_unknown' as const;
export const LISTING_NONCE_USED = 'protocol.listing.nonce_used' as const;
export const LISTING_CHALLENGE_EXPIRED = 'protocol.listing.challenge_expired' as const;
export const LISTING_NOT_OWNER = 'protocol.listing.not_owner' as const;
export const LISTING_OWNER_UNKNOWN = 'protocol.listing.owner_unknown' as const;

export type ListingRefusalCode =
  | typeof LISTING_CHALLENGE_TTL_UNSET
  | typeof LISTING_NONCE_UNKNOWN
  | typeof LISTING_NONCE_USED
  | typeof LISTING_CHALLENGE_EXPIRED
  | typeof LISTING_NOT_OWNER
  | typeof LISTING_OWNER_UNKNOWN;

export class ListingRefusedError extends Error {
  constructor(
    readonly code: ListingRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ListingRefusedError';
  }
}

/** The ERC-1271 magic value a contract returns for a signature it accepts. */
export const ERC1271_MAGIC = '0x1626ba7e' as const;

/** Bounds on the owner's setting: long enough to sign, short enough that a leaked challenge goes stale. */
const TTL_MIN_SECONDS = 30;
const TTL_MAX_SECONDS = 3600;

/**
 * The challenge lifetime in seconds, read once at boot. Blank is null (every challenge refuses). A value outside the bounds
 * refuses to boot. A value labelled TEST (`TEST:300`, the local test stack's) is honoured only when the raw APP_ENV is
 * exactly `dev` or `test`.
 */
export function challengeTtlFromSetting(raw: string | undefined, rawAppEnv: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  const test = /^TEST:/i.exec(value);
  if (test && !isExplicitDevOrTest(rawAppEnv))
    throw new Error(
      `PROTOCOL_LISTING_CHALLENGE_TTL_SECONDS is a TEST value but APP_ENV=${rawAppEnv ?? '(unset)'} is not the local test stack. Refusing to boot.`,
    );
  const digits = test ? value.slice(test[0].length) : value;
  if (!/^\d+$/.test(digits)) throw new Error(`PROTOCOL_LISTING_CHALLENGE_TTL_SECONDS must be whole seconds, got "${value}"`);
  const seconds = Number(digits);
  if (seconds < TTL_MIN_SECONDS || seconds > TTL_MAX_SECONDS)
    throw new Error(`PROTOCOL_LISTING_CHALLENGE_TTL_SECONDS must be ${TTL_MIN_SECONDS} to ${TTL_MAX_SECONDS} seconds, got ${seconds}`);
  return seconds;
}

export interface ListingChallenge {
  readonly nonce: string;
  readonly chainId: number;
  readonly token: Address;
  readonly message: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/**
 * Who owned the token at one block, and that they signed this service's challenge. It is not a lasting right: the owner
 * can change after `blockNumber`. Anything that acts on a proof later (an info update, a listing change) re-reads
 * `owner()` and compares it with `signer`, or refuses a proof older than its own bound, before acting.
 */
export interface OwnershipProof {
  readonly chainId: number;
  readonly token: Address;
  readonly signer: Address;
  readonly nonce: string;
  readonly messageHash: Hex;
  readonly signature: Hex;
  /** The block the owner was read at. */
  readonly blockNumber: bigint;
  readonly verifiedAt: Date;
}

export interface ListingStore {
  putChallenge(challenge: Omit<ListingChallenge, 'usedAt'>): Promise<void>;
  findChallenge(nonce: string): Promise<ListingChallenge | null>;
  /**
   * Marks the nonce used and stores the proof in one step. Returns false when the nonce was already used (a concurrent
   * verify won), so a nonce can back at most one proof.
   */
  consume(nonce: string, usedAt: Date, proof: Omit<OwnershipProof, 'verifiedAt'>): Promise<boolean>;
  /**
   * Deletes challenges that expired before `before` and either were never used or were spent by a failed check, a
   * bounded batch at a time. A challenge with a proof is kept.
   */
  pruneExpired(before: Date): Promise<void>;
  /** Marks a nonce used and failed, with no proof: a failed check spends its challenge, so each challenge buys one check. */
  spend(nonce: string, usedAt: Date): Promise<void>;
}

/** What the service reads from the chain to decide ownership. */
export interface OwnershipChain {
  readonly chainId: number;
  /** The token contract's `owner()`, with the block it was read at; null when the contract names no owner. */
  owner(token: Address): Promise<{ owner: Address; blockNumber: bigint } | null>;
  /** Whether `account` holds code at `blockNumber` (a contract owner answers through ERC-1271). */
  hasCode(account: Address, blockNumber: bigint): Promise<boolean>;
  /** The owner contract's ERC-1271 answer for a message hash and signature, at `blockNumber`. */
  isValidSignature(account: Address, hash: Hex, signature: Hex, blockNumber: bigint): Promise<Hex | null>;
}

const ownerUnknown = () =>
  new ListingRefusedError(
    LISTING_OWNER_UNKNOWN,
    'This token contract names no owner that can be read, so ownership cannot be proven. Nothing is guessed.',
  );

/** The exact text the owner signs. One token, one chain, one nonce and an expiry; it authorises nothing else. */
export function challengeMessage(args: { chainId: number; token: Address; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    'INTAFACED — prove you control this token',
    '',
    'Signing this proves you control the wallet that owns the token below, so you can request an update to its listed',
    'information. It moves no funds and grants no approval.',
    '',
    `token: ${toChecksum(args.token)}`,
    `chain id: ${args.chainId}`,
    `nonce: ${args.nonce}`,
    `issued at: ${args.issuedAt.toISOString()}`,
    `expires at: ${args.expiresAt.toISOString()}`,
  ].join('\n');
}

/**
 * How long after its expiry a challenge is kept before pruning: longer than any verify's chain reads, so a verify that
 * passed the expiry check never finds its row gone. Bookkeeping only; no price, fee or limit comes from it.
 */
export const PRUNE_GRACE_MS = 10 * 60 * 1000;

/** A fresh challenge for a token. The nonce is random (unguessable), stored, and good for one proof before it expires. */
export async function issueChallenge(
  store: ListingStore,
  chain: OwnershipChain,
  ttlSeconds: number | null,
  token: Address,
  now: Date,
  nonce: string = randomBytes(16).toString('hex'),
): Promise<Omit<ListingChallenge, 'usedAt'>> {
  if (ttlSeconds === null)
    throw new ListingRefusedError(LISTING_CHALLENGE_TTL_UNSET, 'The ownership challenge lifetime is not set, so no challenge is issued.');
  // A token that names no owner can never be proven: refuse before anyone is asked to sign, and store nothing.
  if (!(await chain.owner(token))) throw ownerUnknown();
  await store.pruneExpired(new Date(now.getTime() - PRUNE_GRACE_MS));
  const chainId = chain.chainId;
  const issuedAt = new Date(now.getTime());
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const challenge = { nonce, chainId, token: toChecksum(token), issuedAt, expiresAt, message: '' };
  const stored = { ...challenge, message: challengeMessage(challenge) };
  await store.putChallenge(stored);
  return stored;
}

/**
 * Checks a signed challenge against the token's owner and stores the proof. Refuses an unknown, used or expired nonce,
 * a token with no readable owner, and a signer who is not the owner; nothing is stored on a refusal.
 */
export async function verifyOwnership(
  store: ListingStore,
  chain: OwnershipChain,
  input: { nonce: string; signature: Hex },
  now: Date,
): Promise<OwnershipProof> {
  const challenge = await store.findChallenge(input.nonce);
  if (!challenge || challenge.chainId !== chain.chainId)
    throw new ListingRefusedError(LISTING_NONCE_UNKNOWN, 'This challenge was not issued here. Ask for a new one.');
  if (challenge.usedAt) throw new ListingRefusedError(LISTING_NONCE_USED, 'This challenge was already used. Ask for a new one.');
  if (now.getTime() >= challenge.expiresAt.getTime())
    throw new ListingRefusedError(LISTING_CHALLENGE_EXPIRED, 'This challenge has expired. Ask for a new one.');

  const read = await chain.owner(challenge.token);
  if (!read) throw ownerUnknown();
  const owner = toChecksum(read.owner);
  const messageHash = hashMessage(challenge.message);

  let signer: Address | null = null;
  try {
    const recovered = toChecksum(await recoverMessageAddress({ message: challenge.message, signature: input.signature }));
    if (recovered === owner) signer = recovered;
  } catch {
    // Not a recoverable EOA signature; a contract owner may still accept it below.
  }
  if (!signer && (await chain.hasCode(owner, read.blockNumber))) {
    const answer = await chain.isValidSignature(owner, messageHash, input.signature, read.blockNumber);
    if (answer?.toLowerCase() === ERC1271_MAGIC) signer = owner;
  }
  if (!signer) {
    // One challenge, one check: a wrong signature spends the challenge, so it cannot be retried against the chain.
    await store.spend(challenge.nonce, now);
    throw new ListingRefusedError(LISTING_NOT_OWNER, 'The signature is not from the wallet that owns this token. Ask for a new challenge.');
  }

  const proof = {
    chainId: challenge.chainId,
    token: challenge.token,
    signer,
    nonce: challenge.nonce,
    messageHash,
    signature: input.signature,
    blockNumber: read.blockNumber,
  };
  if (!(await store.consume(challenge.nonce, now, proof)))
    throw new ListingRefusedError(LISTING_NONCE_USED, 'This challenge was already used. Ask for a new one.');
  return { ...proof, verifiedAt: now };
}
