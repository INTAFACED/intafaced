import type { BadgeClaimRecord, BadgeStore } from './founding-badge.js';

/**
 * In-memory mint slot for test stores over a `rows` map (RC-more-catalogue-04 single-flight). A slot is held while
 * `mintingSince` is set and no tx hash is stored; storing a tx hash through `setTxHash` ends it because the slot
 * check reads `txHash` first.
 */
export function memMintSlots(
  rows: Map<string, BadgeClaimRecord>,
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
    clearStuckMint: async (k, evidence) => {
      const r = rows.get(k);
      if (!r || r.txHash || !r.mintingSince) return null;
      const next = { ...r, mintingSince: null, txHash: evidence.kind === 'minted' ? evidence.txHash : null };
      rows.set(k, next);
      return next;
    },
  };
}

/** A minimal in-memory `BadgeStore` for the single-flight tests. */
export function memBadgeStore(listed: string[]): BadgeStore & { rows: Map<string, BadgeClaimRecord> } {
  const rows = new Map<string, BadgeClaimRecord>();
  return {
    rows,
    ...memMintSlots(rows),
    isListed: async (id) => listed.includes(id),
    findClaim: async (k) => rows.get(k) ?? null,
    findClaimByAddress: async (c, to) => [...rows.values()].find((r) => r.chainId === c && r.to.toLowerCase() === to.toLowerCase()) ?? null,
    putClaim: async (r) => {
      if (!rows.has(r.key)) rows.set(r.key, r);
      return rows.get(r.key)!;
    },
    setTxHash: async (k, tx) => {
      const r = { ...rows.get(k)!, txHash: rows.get(k)!.txHash ?? tx, mintingSince: null };
      rows.set(k, r);
      return r;
    },
  };
}
