import { getAddress as toChecksum, hashMessage, isAddress, recoverAddress } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * RC-more-catalogue-04 — founding badge eligibility and claim (svc-protocol core).
 *
 * Spec: modules/more-catalogue/specs/recon-2026-10-20.md §RC-more-catalogue-04.
 *
 * No money moves. The claim is an NFT mint to the account's own address, not a
 * ledger entry; this module imports no ledger recipe and holds no balance.
 *
 * - The account id always comes from the signed principal (the caller passes
 *   `principal.userId`); nothing in a request body decides who is eligible.
 * - Eligibility is read from a founder-written stored list. An empty list means
 *   nobody is eligible — no one is invented.
 * - The Drop phase I window is a setting. Blank refuses `badge.window_unset`;
 *   there is no default window.
 * - One claim per account, idempotency key `badge:claim:<account>` (a business
 *   key, never random or time based). A retry after a crash reuses the stored
 *   tx instead of minting again.
 * - Mainnet refuses `audit.external` (no external audit exists); a network with
 *   no configured signer refuses `rail.crypto`. Never `audited: true`.
 */

export const BADGE_WINDOW_UNSET = 'badge.window_unset' as const;
export const BADGE_NOT_ELIGIBLE = 'badge.not_eligible' as const;
export const BADGE_ALREADY_CLAIMED = 'badge.already_claimed' as const;
export const AUDIT_EXTERNAL = 'audit.external' as const;
export const RAIL_CRYPTO = 'rail.crypto' as const;

export type BadgeRefusalCode =
  typeof BADGE_WINDOW_UNSET | typeof BADGE_NOT_ELIGIBLE | typeof BADGE_ALREADY_CLAIMED | typeof AUDIT_EXTERNAL | typeof RAIL_CRYPTO;

export class BadgeRefusedError extends Error {
  constructor(
    readonly code: BadgeRefusalCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'BadgeRefusedError';
  }
}

export interface BadgeWindow {
  opensAt: Date;
  closesAt: Date;
}

export interface BadgeNetwork {
  chainId: number;
  /** True only for a production network. Testnets render as TEST. */
  mainnet: boolean;
}

export interface BadgeClaimRecord {
  key: string;
  accountId: string;
  chainId: number;
  to: Address;
  /** Null between "claim stored" and "mint submitted". */
  txHash: Hex | null;
  /** When the current mint slot was taken; null/absent when no mint is in flight. Stays set if a mint got stuck. */
  mintingSince?: Date | null;
}

export interface BadgeStore {
  /** Founder-desk written list. */
  isListed(accountId: string): Promise<boolean>;
  findClaim(key: string): Promise<BadgeClaimRecord | null>;
  /** The claim already minted to this address on this chain, by any account. */
  findClaimByAddress(chainId: number, to: Address): Promise<BadgeClaimRecord | null>;
  /** Insert-if-absent on `key`; returns the stored row either way. */
  putClaim(record: BadgeClaimRecord): Promise<BadgeClaimRecord>;
  /**
   * Atomically take the mint slot for `key`: true for exactly one caller while the claim has no tx hash and no mint
   * in flight. Only the winner calls the signer, so two concurrent claims (or a retry during a mint) mint once.
   */
  claimMintSlot(key: string): Promise<boolean>;
  /** Give the slot back after the signer threw before returning a tx hash, so a later retry can mint. */
  releaseMintSlot(key: string): Promise<void>;
  /**
   * Operator clear of a stuck slot (tx hash null, slot set). `minted` stores the hash; `not_minted` frees the slot.
   * Returns null when there is nothing stuck to clear.
   */
  clearStuckMint(key: string, evidence: BadgeStuckMintEvidence): Promise<BadgeClaimRecord | null>;
  /** Stores the tx hash (first one wins) and clears the mint slot. */
  setTxHash(key: string, txHash: Hex): Promise<BadgeClaimRecord>;
}

/**
 * Thrown by a signer only when it is certain nothing was broadcast (e.g. it refused before signing). Only this
 * error gives the mint slot back; any other error keeps the slot, because the mint may be on chain.
 */
export class BadgeMintNotSentError extends Error {
  constructor(detail: string) {
    super(`badge mint not sent: ${detail}`);
    this.name = 'BadgeMintNotSentError';
  }
}

export interface BadgeMinter {
  /**
   * Null when no signer is configured for this network.
   *
   * `mint(to, key)` MUST be idempotent on `key`: a second call with the same key must not mint a second badge
   * (e.g. a keyed mint the contract refuses to repeat). It throws `BadgeMintNotSentError` only when nothing was sent.
   */
  signerFor(chainId: number): { mint(to: Address, key: string): Promise<Hex> } | null;
}

/** Chain evidence an operator must give to clear a stuck mint slot. */
export type BadgeStuckMintEvidence = { kind: 'minted'; txHash: Hex } | { kind: 'not_minted'; attestedBy: string; checkedAt: Date };

export interface BadgeDeps {
  store: BadgeStore;
  minter: BadgeMinter;
  /** Drop phase I window as published by the founder desk; undefined/null = blank. */
  window: BadgeWindow | null | undefined;
  now: () => Date;
}

export function badgeClaimKey(accountId: string): string {
  if (!accountId) throw new Error('badgeClaimKey: account id is required');
  return `badge:claim:${accountId}`;
}

export function requireBadgeWindow(window: BadgeWindow | null | undefined): BadgeWindow {
  if (
    !window ||
    !(window.opensAt instanceof Date) ||
    !(window.closesAt instanceof Date) ||
    Number.isNaN(window.opensAt.getTime()) ||
    Number.isNaN(window.closesAt.getTime()) ||
    window.closesAt.getTime() <= window.opensAt.getTime()
  ) {
    throw new BadgeRefusedError(BADGE_WINDOW_UNSET, 'Drop phase I window is not set');
  }
  return window;
}

export interface BadgeEligibility {
  eligible: boolean;
  claimed: boolean;
  label: 'TEST' | 'MAINNET';
  audited: false;
  txHash: Hex | null;
}

export async function badgeEligibility(deps: BadgeDeps, accountId: string, network: BadgeNetwork): Promise<BadgeEligibility> {
  requireBadgeWindow(deps.window);
  const claim = await deps.store.findClaim(badgeClaimKey(accountId));
  const eligible = await deps.store.isListed(accountId);
  return {
    eligible,
    claimed: claim !== null,
    label: network.mainnet ? 'MAINNET' : 'TEST',
    audited: false,
    txHash: claim?.txHash ?? null,
  };
}

/**
 * The message the registered smart account's owner key signs to claim. Names the claim key and the chain; it
 * authorises one badge mint to the account's own address and nothing else.
 */
export function badgeClaimMessage(args: { accountId: string; chainId: number; address: Address }): string {
  return [
    'INTAFACED — claim founding badge',
    '',
    `key:     ${badgeClaimKey(args.accountId)}`,
    `chain:   ${args.chainId}`,
    `to:      ${toChecksum(args.address)}`,
    '',
    'Signing this claims one founding badge NFT to your own account.',
    'It grants no other permission and moves no funds.',
  ].join('\n');
}

/** The caller's own registered smart account, resolved server side from the registry. */
export interface BadgeOwnAccount {
  address: string;
  owner: string;
}

async function signedByOwner(message: string, owner: string, signature: string | null | undefined): Promise<boolean> {
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature) || !isAddress(owner, { strict: false })) return false;
  try {
    const recovered = await recoverAddress({ hash: hashMessage(message), signature: signature as Hex });
    return toChecksum(recovered) === toChecksum(owner);
  } catch {
    return false;
  }
}

export async function claimBadge(
  deps: BadgeDeps,
  accountId: string,
  own: BadgeOwnAccount | null | undefined,
  network: BadgeNetwork,
  signature: string | null | undefined,
): Promise<BadgeClaimRecord & { label: 'TEST'; audited: false }> {
  const window = requireBadgeWindow(deps.window);
  if (network.mainnet) {
    throw new BadgeRefusedError(AUDIT_EXTERNAL, 'mainnet mint needs an external audit that does not exist');
  }
  const key = badgeClaimKey(accountId);
  const existing = await deps.store.findClaim(key);
  if (existing && existing.txHash) return { ...existing, label: 'TEST', audited: false };

  if (!existing) {
    const t = deps.now().getTime();
    // Outside Drop phase I the account is not eligible (spec code; no extra refusal is invented).
    if (t < window.opensAt.getTime() || t >= window.closesAt.getTime()) {
      throw new BadgeRefusedError(BADGE_NOT_ELIGIBLE, 'outside the Drop phase I window');
    }
    if (!(await deps.store.isListed(accountId))) {
      throw new BadgeRefusedError(BADGE_NOT_ELIGIBLE, 'account is not on the founding list');
    }
  }
  // The address is the account's own registered smart account, resolved server side.
  // No registered account means there is nowhere of its own to mint to.
  const ownAddress = own?.address;
  if (!own || !ownAddress || !isAddress(ownAddress, { strict: false })) {
    throw new BadgeRefusedError(BADGE_NOT_ELIGIBLE, 'account has no registered smart account address');
  }
  // The owner key of the account's own registered smart account must sign the claim, verified before anything is stored.
  const message = badgeClaimMessage({ accountId, chainId: network.chainId, address: toChecksum(ownAddress) });
  if (!(await signedByOwner(message, own.owner, signature))) {
    throw new BadgeRefusedError(BADGE_NOT_ELIGIBLE, 'claim signature missing or not from the account owner key');
  }
  // One badge per address: another account already claimed to this address.
  const onAddress = await deps.store.findClaimByAddress(network.chainId, toChecksum(ownAddress));
  if (onAddress && onAddress.accountId !== accountId) {
    throw new BadgeRefusedError(BADGE_ALREADY_CLAIMED, 'a founding badge was already claimed to this address');
  }
  const signer = deps.minter.signerFor(network.chainId);
  if (!signer) throw new BadgeRefusedError(RAIL_CRYPTO, `no signer configured for chain ${network.chainId}`);

  const stored =
    existing ?? (await deps.store.putClaim({ key, accountId, chainId: network.chainId, to: toChecksum(ownAddress), txHash: null }));
  if (stored.txHash) return { ...stored, label: 'TEST', audited: false };
  // Single flight: only the caller that wins the slot mints. A loser returns the stored claim; a null txHash means
  // the winner's mint is still pending.
  if (!(await deps.store.claimMintSlot(key))) {
    const current = (await deps.store.findClaim(key)) ?? stored;
    return { ...current, label: 'TEST', audited: false };
  }
  let txHash: Hex;
  try {
    txHash = await signer.mint(stored.to, key);
  } catch (err) {
    // Only a typed "nothing sent" error frees the slot; anything else may have reached the chain, so the claim stays
    // pending until an operator clears it with chain evidence (resolveStuckBadgeMint).
    if (err instanceof BadgeMintNotSentError) await deps.store.releaseMintSlot(key);
    throw err;
  }
  const done = await deps.store.setTxHash(key, txHash);
  return { ...done, label: 'TEST', audited: false };
}

/**
 * Operator-only (not mounted on any customer route): clear a claim stuck pending after a crash mid-mint. Requires
 * chain evidence: the tx hash that did mint, or an explicit named "not minted" attestation. Refuses blank evidence.
 */
export async function resolveStuckBadgeMint(
  store: BadgeStore,
  accountId: string,
  evidence: BadgeStuckMintEvidence,
): Promise<BadgeClaimRecord | null> {
  if (evidence.kind === 'minted') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash)) throw new Error('resolveStuckBadgeMint: minted needs a tx hash');
  } else if (evidence.kind === 'not_minted') {
    if (!evidence.attestedBy?.trim() || !(evidence.checkedAt instanceof Date) || Number.isNaN(evidence.checkedAt.getTime())) {
      throw new Error('resolveStuckBadgeMint: not_minted needs a named attester and a check time');
    }
  } else {
    throw new Error('resolveStuckBadgeMint: evidence is required');
  }
  return store.clearStuckMint(badgeClaimKey(accountId), evidence);
}

/** Founder setting to window; either side blank = null (`badge.window_unset`). */
export function badgeWindowFromSetting(opensAt: string | undefined, closesAt: string | undefined): BadgeWindow | null {
  if (!opensAt || !closesAt) return null;
  return { opensAt: new Date(opensAt), closesAt: new Date(closesAt) };
}

/**
 * Mainnet unless the owner's network registry names this chain `testnet` or `local`. An unknown or `unconfirmed`
 * chain is treated as mainnet, so it refuses `audit.external` rather than minting.
 */
export function badgeChainIsMainnet(chainId: number, networks: ReadonlyArray<{ chainId: number; kind: string }>): boolean {
  const entry = networks.find((n) => n.chainId === chainId);
  return !(entry && (entry.kind === 'testnet' || entry.kind === 'local'));
}

/** No badge signer is wired yet: every network refuses `rail.crypto` from `claimBadge` itself. */
export const noBadgeSigner: BadgeMinter = { signerFor: () => null };
