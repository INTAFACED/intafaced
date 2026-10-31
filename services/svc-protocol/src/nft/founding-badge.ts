import { getAddress as toChecksum, hashMessage, isAddress, recoverAddress } from 'viem';
import { createHash } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { isExplicitDevOrTest } from '@intafaced/config';
import { fromAnotherChain, type ChainIdentity } from '../chain/identity.js';

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

/** Operator clear of a stuck mint slot: blank or malformed chain evidence, or a blank reason. */
export const BADGE_STUCK_EVIDENCE_REQUIRED = 'badge.stuck_evidence_required' as const;
/** The owner-set stale age (`PROTOCOL_BADGE_STUCK_MINT_AGE_SECONDS`) is blank; there is no default. */
export const BADGE_STUCK_AGE_UNSET = 'badge.stuck_age_unset' as const;
/** The slot was taken more recently than the stale age; the mint may still be in flight. */
export const BADGE_STUCK_NOT_STALE = 'badge.stuck_not_stale' as const;
/** IDENTITY_URL / INTERNAL_SERVICE_SECRET unset: no second person can be proven, so nothing is cleared. */
export const BADGE_STUCK_APPROVAL_UNWIRED = 'badge.stuck_approval_unwired' as const;
/** Identity refused the approval, or it is not a distinct-person (four-eyes) approval of this exact clear. */
export const BADGE_STUCK_APPROVAL_REFUSED = 'badge.stuck_approval_refused' as const;

/**
 * A stored claim names another genesis on a chain that is not started again (not `local`, not APP_ENV dev or test). A
 * long-lived chain keeps its genesis, so this is a node or RPC answering for another chain: the claim is not reset, and
 * nothing is minted or cleared until the chain answers as itself.
 */
export const BADGE_CHAIN_CHANGED = 'badge.chain_changed' as const;

export type BadgeRefusalCode =
  | typeof BADGE_WINDOW_UNSET
  | typeof BADGE_NOT_ELIGIBLE
  | typeof BADGE_ALREADY_CLAIMED
  | typeof AUDIT_EXTERNAL
  | typeof RAIL_CRYPTO
  | typeof BADGE_STUCK_EVIDENCE_REQUIRED
  | typeof BADGE_STUCK_AGE_UNSET
  | typeof BADGE_STUCK_NOT_STALE
  | typeof BADGE_STUCK_APPROVAL_UNWIRED
  | typeof BADGE_STUCK_APPROVAL_REFUSED
  | typeof BADGE_CHAIN_CHANGED;

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
  /**
   * Which chain this is (`chain/identity.ts`), read only when needed: a claim asks for it fresh after its own refusals,
   * eligibility only when a stored claim names a genesis.
   */
  identity(opts?: { fresh?: boolean }): Promise<ChainIdentity>;
  /** True only for a production network. Testnets render as TEST. */
  mainnet: boolean;
  /**
   * True only for a chain that is started again from a new genesis (`badgeChainIsRestartable`). There a claim from
   * another genesis is set aside and claimed again; anywhere else it refuses `badge.chain_changed` and is kept.
   */
  restartable: boolean;
}

export interface BadgeClaimRecord {
  key: string;
  accountId: string;
  chainId: number;
  to: Address;
  /** The genesis of the chain the claim was made on; null for a claim stored before the column existed. */
  genesisHash?: Hex | null;
  /** Null between "claim stored" and "mint submitted". */
  txHash: Hex | null;
  /** When the current mint slot was taken; null/absent when no mint is in flight. Stays set if a mint got stuck. */
  mintingSince?: Date | null;
}

export interface BadgeStore {
  /** Founder-desk written list. */
  isListed(accountId: string): Promise<boolean>;
  findClaim(key: string): Promise<BadgeClaimRecord | null>;
  /** The claim to this address on this chain (this genesis, or a claim stored before the column), by any account. */
  findClaimByAddress(chain: ChainIdentity, to: Address): Promise<BadgeClaimRecord | null>;
  /**
   * Insert-if-absent on `key`; returns the stored row either way. With `replaceOtherGenesis` (a restartable chain only), a
   * stored claim from another genesis is replaced: its mint did not happen on this chain, so the claim starts again with
   * no tx hash. Without it, that claim is returned as it is and the caller refuses `badge.chain_changed`. Refuses
   * `badge.already_claimed` when another account's claim holds the address (a race the `findClaimByAddress` check before
   * it can lose).
   */
  putClaim(record: BadgeClaimRecord, opts: { replaceOtherGenesis: boolean }): Promise<BadgeClaimRecord>;
  /**
   * Atomically take the mint slot for `key`: true for exactly one caller while the claim has no tx hash and no mint
   * in flight. Only the winner calls the signer, so two concurrent claims (or a retry during a mint) mint once.
   */
  claimMintSlot(key: string): Promise<boolean>;
  /** Give the slot back after the signer threw before returning a tx hash, so a later retry can mint. */
  releaseMintSlot(key: string): Promise<void>;
  /**
   * Operator clear of a stuck slot (tx hash null, slot taken at or before `staleBefore`). `minted` stores the hash;
   * `not_minted` frees the slot. The audit row is written in the same transaction as the clear. Returns null (and
   * writes nothing) when there is nothing stuck and stale to clear.
   */
  clearStuckMint(
    key: string,
    evidence: BadgeStuckMintEvidence,
    audit: BadgeStuckMintAudit,
    staleBefore: Date,
  ): Promise<BadgeClaimRecord | null>;
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

/** Who cleared a stuck slot, who approved it, and why. Stored with the clear (`protocol.founding_badge_mint_clears`). */
export interface BadgeStuckMintAudit {
  actorId: string;
  requesterId: string;
  approverId: string;
  approvalId: string;
  reason: string;
}

/** The identity action-approval consume port (`createIdentityApprovalClient`); null = unwired. */
export interface BadgeApprovalConsumer {
  consume(input: {
    approvalId: string;
    operationId: string;
    payloadHash: string;
    targetService: string;
    targetId: string;
    expectedVersion: string;
  }): Promise<{ status: string; requesterId: string; approverId: string | null }>;
}

export const BADGE_CLEAR_STUCK_ACTION = 'protocol.badge.clear_stuck_mint' as const;

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

/**
 * A claim made on another chain is not this chain's claim. On a restartable chain (a TEST chain since started again) it
 * reads as none. Anywhere else the chain id names a chain that keeps its genesis, so a different genesis is a node
 * answering for another chain: refuse rather than reset the claim and mint a second badge.
 */
function thisChains(claim: BadgeClaimRecord | null, current: ChainIdentity, restartable: boolean): BadgeClaimRecord | null {
  if (!claim || !fromAnotherChain(claim.genesisHash, current)) return claim;
  if (restartable) return null;
  throw new BadgeRefusedError(
    BADGE_CHAIN_CHANGED,
    `chain ${current.chainId} answers with genesis ${current.genesisHash}, not ${claim.genesisHash}, and is not a chain that is started again`,
  );
}

export async function badgeEligibility(deps: BadgeDeps, accountId: string, network: BadgeNetwork): Promise<BadgeEligibility> {
  requireBadgeWindow(deps.window);
  const stored = await deps.store.findClaim(badgeClaimKey(accountId));
  // The chain is asked only when the stored claim names a genesis; no claim, or one from before the column, needs none.
  let claim = stored;
  if (stored?.genesisHash) {
    // A reused identity that disagrees is read again before it decides: one stray answer is not held for the whole TTL.
    let here = await network.identity();
    if (fromAnotherChain(stored.genesisHash, here)) here = await network.identity({ fresh: true });
    claim = thisChains(stored, here, network.restartable);
  }
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
  // Read afresh: the claim below is stored with this genesis, and a mint must never be labelled with a chain since gone.
  const here = await network.identity({ fresh: true });
  const existing = thisChains(await deps.store.findClaim(key), here, network.restartable);
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
  const onAddress = await deps.store.findClaimByAddress(here, toChecksum(ownAddress));
  if (onAddress && onAddress.accountId !== accountId) {
    throw new BadgeRefusedError(BADGE_ALREADY_CLAIMED, 'a founding badge was already claimed to this address');
  }
  const signer = deps.minter.signerFor(network.chainId);
  if (!signer) throw new BadgeRefusedError(RAIL_CRYPTO, `no signer configured for chain ${network.chainId}`);

  // A racing call can store this key between the read above and this write. The stored row is judged again: on a chain
  // that is not restartable, a claim from another genesis is never replaced and refuses `badge.chain_changed`.
  const stored =
    existing ??
    thisChains(
      await deps.store.putClaim(
        { key, accountId, chainId: network.chainId, genesisHash: here.genesisHash, to: toChecksum(ownAddress), txHash: null },
        { replaceOtherGenesis: network.restartable },
      ),
      here,
      network.restartable,
    );
  // Null only if a store asked to replace another genesis's claim did not: never mint against another chain's claim.
  if (!stored) throw new Error(`founding badge claim ${key} is still from another genesis after a replacing write`);
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

/** Payload hash an approver signs off on for a stuck-mint clear (svc-pay `payActionPayloadHash` shape). */
export function badgeClearPayloadHash(key: string, mintingSince: Date, evidence: BadgeStuckMintEvidence, reason: string): string {
  const fields =
    evidence.kind === 'minted'
      ? { key, mintingSince: mintingSince.toISOString(), kind: 'minted', txHash: evidence.txHash.toLowerCase(), reason }
      : {
          key,
          mintingSince: mintingSince.toISOString(),
          kind: 'not_minted',
          attestedBy: evidence.attestedBy.trim(),
          checkedAt: evidence.checkedAt.toISOString(),
          reason,
        };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType: BADGE_CLEAR_STUCK_ACTION, ...fields }))
    .digest('hex')}`;
}

export interface ResolveStuckMintDeps {
  store: BadgeStore;
  /** Null when IDENTITY_URL / INTERNAL_SERVICE_SECRET are unset: refuses `badge.stuck_approval_unwired`. */
  approvals: BadgeApprovalConsumer | null;
  /** Owner-set stale age in seconds; undefined refuses `badge.stuck_age_unset` (no default). */
  staleAfterSeconds: number | undefined;
  now: () => Date;
  /** Which chain this is. A stuck slot from another genesis is not stuck on this chain: there is nothing here to clear. */
  identity?: () => Promise<ChainIdentity>;
  /** As `BadgeNetwork.restartable`: absent or false, a stuck slot from another genesis refuses `badge.chain_changed`. */
  restartable?: boolean;
}

export interface ResolveStuckMintInput {
  accountId: string;
  evidence: BadgeStuckMintEvidence;
  reason: string;
  /** The operator principal calling the admin route. */
  actorId: string;
  approvalId: string;
  operationId: string;
}

/**
 * Operator clear (admin route `badge.resolveStuckMint`) of a claim stuck pending after a crash mid-mint. Requires
 * chain evidence, a reason, a slot older than the owner-set stale age, and a four-eyes identity approval bound to the
 * exact payload (key, slot time, evidence, reason). The approver must differ from the proposer and from the actor.
 * Returns null when nothing is stuck (no approval is consumed).
 */
export async function resolveStuckBadgeMint(deps: ResolveStuckMintDeps, input: ResolveStuckMintInput): Promise<BadgeClaimRecord | null> {
  const { evidence } = input;
  if (evidence?.kind === 'minted') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash)) throw new BadgeRefusedError(BADGE_STUCK_EVIDENCE_REQUIRED, 'minted needs a tx hash');
  } else if (evidence?.kind === 'not_minted') {
    if (!evidence.attestedBy?.trim() || !(evidence.checkedAt instanceof Date) || Number.isNaN(evidence.checkedAt.getTime())) {
      throw new BadgeRefusedError(BADGE_STUCK_EVIDENCE_REQUIRED, 'not_minted needs a named attester and a check time');
    }
  } else {
    throw new BadgeRefusedError(BADGE_STUCK_EVIDENCE_REQUIRED, 'chain evidence is required');
  }
  const reason = input.reason?.trim() ?? '';
  if (!reason) throw new BadgeRefusedError(BADGE_STUCK_EVIDENCE_REQUIRED, 'a reason is required');
  if (deps.staleAfterSeconds === undefined) {
    throw new BadgeRefusedError(BADGE_STUCK_AGE_UNSET, 'PROTOCOL_BADGE_STUCK_MINT_AGE_SECONDS is unset; no default stale age');
  }
  const key = badgeClaimKey(input.accountId);
  const found = await deps.store.findClaim(key);
  const claim = found?.genesisHash && deps.identity ? thisChains(found, await deps.identity(), deps.restartable ?? false) : found;
  if (!claim || claim.txHash || !claim.mintingSince) return null;
  const staleBefore = new Date(deps.now().getTime() - deps.staleAfterSeconds * 1000);
  if (claim.mintingSince.getTime() > staleBefore.getTime()) {
    throw new BadgeRefusedError(BADGE_STUCK_NOT_STALE, `mint slot taken at ${claim.mintingSince.toISOString()} is not stale yet`);
  }
  if (!deps.approvals) {
    throw new BadgeRefusedError(BADGE_STUCK_APPROVAL_UNWIRED, 'identity approval is not wired; a second person cannot be proven');
  }
  const approvalId = input.approvalId?.trim() ?? '';
  const operationId = input.operationId?.trim() ?? '';
  if (!approvalId || !operationId) throw new BadgeRefusedError(BADGE_STUCK_APPROVAL_REFUSED, 'approvalId and operationId are required');
  let consumed: { status: string; requesterId: string; approverId: string | null };
  try {
    consumed = await deps.approvals.consume({
      approvalId,
      operationId,
      payloadHash: badgeClearPayloadHash(key, claim.mintingSince, evidence, reason),
      targetService: 'svc-protocol',
      targetId: key,
      expectedVersion: claim.mintingSince.toISOString(),
    });
  } catch (err) {
    if (err instanceof BadgeRefusedError) throw err;
    throw new BadgeRefusedError(BADGE_STUCK_APPROVAL_REFUSED, `identity refused the approval: ${(err as Error).message}`);
  }
  const approver = consumed.approverId?.trim() ?? '';
  const requester = consumed.requesterId?.trim() ?? '';
  if (consumed.status !== 'CONSUMED' || !approver || !requester) {
    throw new BadgeRefusedError(BADGE_STUCK_APPROVAL_REFUSED, 'identity did not return a consumed approval with an approver');
  }
  if (approver.toLowerCase() === requester.toLowerCase() || approver.toLowerCase() === input.actorId.trim().toLowerCase()) {
    throw new BadgeRefusedError(BADGE_STUCK_APPROVAL_REFUSED, 'the approver must be a second person, not the proposer or the actor');
  }
  return deps.store.clearStuckMint(
    key,
    evidence,
    { actorId: input.actorId, requesterId: requester, approverId: approver, approvalId, reason },
    staleBefore,
  );
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

/**
 * A chain that is started again from a new genesis: the owner's registry names it `local`, or APP_ENV is exactly dev or
 * test and the RPC is this machine (the local stack runs anvil on loopback under the app's network id). A dev or test
 * service pointed at a public testnet is not restartable. Pass the raw APP_ENV: an unset one is not a TEST stack.
 */
export function badgeChainIsRestartable(
  chainId: number,
  networks: ReadonlyArray<{ chainId: number; kind: string }>,
  appEnv: string | null | undefined,
  rpcUrl: string | null | undefined,
): boolean {
  if (networks.some((n) => n.chainId === chainId && n.kind === 'local')) return true;
  return isExplicitDevOrTest(appEnv) && isLoopbackUrl(rpcUrl);
}

function isLoopbackUrl(url: string | null | undefined): boolean {
  try {
    const host = new URL(url ?? '').hostname;
    return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** No badge signer is wired yet: every network refuses `rail.crypto` from `claimBadge` itself. */
export const noBadgeSigner: BadgeMinter = { signerFor: () => null };
