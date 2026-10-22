import { getAddress as toChecksum, isAddress } from 'viem';
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
export const BADGE_WINDOW_CLOSED = 'badge.window_closed' as const;
export const AUDIT_EXTERNAL = 'audit.external' as const;
export const RAIL_CRYPTO = 'rail.crypto' as const;

export type BadgeRefusalCode =
  | typeof BADGE_WINDOW_UNSET
  | typeof BADGE_NOT_ELIGIBLE
  | typeof BADGE_ALREADY_CLAIMED
  | typeof BADGE_WINDOW_CLOSED
  | typeof AUDIT_EXTERNAL
  | typeof RAIL_CRYPTO;

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
}

export interface BadgeStore {
  /** Founder-desk written list. */
  isListed(accountId: string): Promise<boolean>;
  findClaim(key: string): Promise<BadgeClaimRecord | null>;
  /** Insert-if-absent on `key`; returns the stored row either way. */
  putClaim(record: BadgeClaimRecord): Promise<BadgeClaimRecord>;
  setTxHash(key: string, txHash: Hex): Promise<BadgeClaimRecord>;
}

export interface BadgeMinter {
  /** Null when no signer is configured for this network. */
  signerFor(chainId: number): { mint(to: Address, key: string): Promise<Hex> } | null;
}

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

export async function claimBadge(
  deps: BadgeDeps,
  accountId: string,
  ownAddress: string,
  network: BadgeNetwork,
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
    if (t < window.opensAt.getTime() || t >= window.closesAt.getTime()) {
      throw new BadgeRefusedError(BADGE_WINDOW_CLOSED, 'outside the Drop phase I window');
    }
    if (!(await deps.store.isListed(accountId))) {
      throw new BadgeRefusedError(BADGE_NOT_ELIGIBLE, 'account is not on the founding list');
    }
  }
  if (!isAddress(ownAddress, { strict: false })) {
    throw new Error('claimBadge: own address is not an EVM address');
  }
  const signer = deps.minter.signerFor(network.chainId);
  if (!signer) throw new BadgeRefusedError(RAIL_CRYPTO, `no signer configured for chain ${network.chainId}`);

  const stored =
    existing ?? (await deps.store.putClaim({ key, accountId, chainId: network.chainId, to: toChecksum(ownAddress), txHash: null }));
  if (stored.accountId !== accountId) {
    throw new BadgeRefusedError(BADGE_ALREADY_CLAIMED, 'claim key belongs to another account');
  }
  if (stored.txHash) return { ...stored, label: 'TEST', audited: false };
  const txHash = await signer.mint(stored.to, key);
  const done = await deps.store.setTxHash(key, txHash);
  return { ...done, label: 'TEST', audited: false };
}
