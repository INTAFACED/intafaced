import type { BadgeClaimRecord, BadgeStore, BadgeStuckMintAudit, BadgeStuckMintEvidence } from './founding-badge.js';

export type MemClearAudit = BadgeStuckMintAudit & { key: string; evidence: BadgeStuckMintEvidence };

/**
 * In-memory mint slot for test stores over a `rows` map (RC-more-catalogue-04 single-flight). A slot is held while
 * `mintingSince` is set and no tx hash is stored; storing a tx hash through `setTxHash` ends it because the slot
 * check reads `txHash` first.
 */
export function memMintSlots(
  rows: Map<string, BadgeClaimRecord>,
  audits: MemClearAudit[] = [],
): Pick<BadgeStore, 'claimMintSlot' | 'releaseMintSlot' | 'clearStuckMint'> {
  return {
    claimMintSlot: async (k) => {
      const r = rows.get(k);
      if (!r || r.txHash || r.mintingSince) return false;
      rows.set(k, { ...r, mintingSince: new Date() });
      return true;
    },
    releaseMintSlot: async (k) => {
      const r = rows.get(k);
      if (r && !r.txHash) rows.set(k, { ...r, mintingSince: null });
    },
    clearStuckMint: async (k, evidence, audit, staleBefore) => {
      const r = rows.get(k);
      if (!r || r.txHash || !r.mintingSince || r.mintingSince.getTime() > staleBefore.getTime()) return null;
      audits.push({ ...audit, key: k, evidence });
      const next = { ...r, mintingSince: null, txHash: evidence.kind === 'minted' ? evidence.txHash : null };
      rows.set(k, next);
      return next;
    },
  };
}

/** A minimal in-memory `BadgeStore` for the single-flight tests. */
export function memBadgeStore(listed: string[]): BadgeStore & { rows: Map<string, BadgeClaimRecord>; audits: MemClearAudit[] } {
  const rows = new Map<string, BadgeClaimRecord>();
  const audits: MemClearAudit[] = [];
  return {
    rows,
    audits,
    ...memMintSlots(rows, audits),
    isListed: async (id) => listed.includes(id),
    findClaim: async (k) => rows.get(k) ?? null,
    findClaimByAddress: async (c, to) =>
      [...rows.values()].find(
        (r) => r.chainId === c.chainId && (r.genesisHash ?? c.genesisHash) === c.genesisHash && r.to.toLowerCase() === to.toLowerCase(),
      ) ?? null,
    putClaim: async (r, opts) => {
      const held = rows.get(r.key);
      // A claim from another genesis is replaced only when asked (a restartable chain), as the Postgres store does.
      const otherGenesis = held?.genesisHash && r.genesisHash && held.genesisHash !== r.genesisHash;
      if (!held || (otherGenesis && opts.replaceOtherGenesis)) rows.set(r.key, r);
      return rows.get(r.key)!;
    },
    setTxHash: async (k, tx) => {
      const r = { ...rows.get(k)!, txHash: rows.get(k)!.txHash ?? tx, mintingSince: null };
      rows.set(k, r);
      return r;
    },
  };
}
