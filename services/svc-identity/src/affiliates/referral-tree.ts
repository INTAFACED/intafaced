/**
 * AFFILIATE / IB REFERRAL TREE — Slice A (TRK-ops.affiliates).
 *
 * Attribution edges only: who introduced whom. NO commission rates, NO fee
 * accrual, NO ledger payouts (Slice B/C Class M).
 *
 * Law:
 *   · self-referral refused
 *   · cycles refused (A→B→…→A)
 *   · depth capped (DEFAULT_MAX_REFERRAL_DEPTH) so multi-tier payout later has a bound
 *   · one parent per user (re-attribute refused once set — audit integrity)
 */

/** Product default multi-tier depth (referrer chain length). */
export const DEFAULT_MAX_REFERRAL_DEPTH = 5;

export type ReferralErrorCode =
  | 'referral.self'
  | 'referral.cycle'
  | 'referral.depth'
  | 'referral.already_set'
  | 'referral.unknown_referrer'
  | 'referral.invalid'
  | 'referral.attach_window_unset'
  | 'referral.attach_window_closed'
  | 'referral.code_length_unset'
  | 'referral.code_exhausted'
  | 'referral.rebind_not_needed'
  | 'referral.rebind_open'
  | 'referral.rebind_not_found'
  | 'referral.rebind_not_open'
  | 'referral.rebind_stale';

export class ReferralError extends Error {
  constructor(
    message: string,
    readonly code: ReferralErrorCode,
  ) {
    super(message);
    this.name = 'ReferralError';
  }
}

export interface ReferralEdge {
  userId: string;
  referrerId: string;
  /** When the edge was written (audit). */
  attributedAt: Date;
}

/**
 * Pure graph helpers — no I/O.
 *
 * `parent` map: userId → referrerId
 */
export function wouldCreateCycle(parent: ReadonlyMap<string, string>, userId: string, referrerId: string): boolean {
  // Walk from referrer upward; if we hit userId, attaching userId→referrer closes a cycle.
  let cur: string | undefined = referrerId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === userId) return true;
    if (seen.has(cur)) return true; // corrupt graph
    seen.add(cur);
    cur = parent.get(cur);
  }
  return false;
}

/**
 * Post-insert / integrity: true if the upward chain from `start` revisits a node.
 * Used after a durable edge write so concurrent races cannot leave a cycle committed.
 */
export function chainHasCycle(parent: ReadonlyMap<string, string>, start: string): boolean {
  let cur: string | undefined = parent.get(start);
  const seen = new Set<string>([start]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parent.get(cur);
  }
  return false;
}

/** How many hops from user to root (0 if no parent). */
export function chainDepth(parent: ReadonlyMap<string, string>, userId: string): number {
  let depth = 0;
  let cur: string | undefined = parent.get(userId);
  const seen = new Set<string>();
  while (cur) {
    depth += 1;
    if (seen.has(cur)) throw new ReferralError('Referral graph contains a cycle', 'referral.cycle');
    seen.add(cur);
    cur = parent.get(cur);
  }
  return depth;
}

/** Ancestors of user, nearest parent first, up to maxDepth entries. */
export function ancestors(parent: ReadonlyMap<string, string>, userId: string, maxDepth: number = DEFAULT_MAX_REFERRAL_DEPTH): string[] {
  const out: string[] = [];
  let cur: string | undefined = parent.get(userId);
  const seen = new Set<string>();
  while (cur && out.length < maxDepth) {
    if (seen.has(cur)) throw new ReferralError('Referral graph contains a cycle', 'referral.cycle');
    seen.add(cur);
    out.push(cur);
    cur = parent.get(cur);
  }
  return out;
}

/**
 * In-memory referral store for Slice A tests + process-local use.
 * Durable SQL edge residual before multi-instance production.
 */
export class MemoryReferralTree {
  private readonly parent = new Map<string, string>();
  private readonly at = new Map<string, Date>();

  constructor(private readonly maxDepth: number = DEFAULT_MAX_REFERRAL_DEPTH) {}

  /**
   * Attribute `userId` to `referrerId` once.
   * Referrer must already exist as a known user id (caller supplies existence check)
   * OR already be in the tree / be allowed as root — we only require referrerId ≠ empty.
   */
  attribute(input: { userId: string; referrerId: string; now?: Date; knownUserIds?: ReadonlySet<string> }): ReferralEdge {
    const userId = input.userId.trim();
    const referrerId = input.referrerId.trim();
    if (!userId || !referrerId) {
      throw new ReferralError('userId and referrerId are required', 'referral.invalid');
    }
    if (userId === referrerId) {
      throw new ReferralError('Self-referral is refused', 'referral.self');
    }
    if (this.parent.has(userId)) {
      throw new ReferralError('Referral already set for this user', 'referral.already_set');
    }
    if (input.knownUserIds && !input.knownUserIds.has(referrerId)) {
      throw new ReferralError('Referrer is not a known user', 'referral.unknown_referrer');
    }
    if (wouldCreateCycle(this.parent, userId, referrerId)) {
      throw new ReferralError('Referral would create a cycle', 'referral.cycle');
    }
    // Depth of the new user = depth(referrer) + 1 must be ≤ maxDepth
    const referrerDepth = chainDepth(this.parent, referrerId);
    if (referrerDepth + 1 > this.maxDepth) {
      throw new ReferralError(`Referral depth exceeds max ${this.maxDepth} (referrer chain is already ${referrerDepth})`, 'referral.depth');
    }

    const attributedAt = input.now ?? new Date();
    this.parent.set(userId, referrerId);
    this.at.set(userId, attributedAt);
    return { userId, referrerId, attributedAt };
  }

  parentOf(userId: string): string | null {
    return this.parent.get(userId) ?? null;
  }

  edgeOf(userId: string): ReferralEdge | null {
    const referrerId = this.parent.get(userId);
    if (!referrerId) return null;
    return { userId, referrerId, attributedAt: this.at.get(userId)! };
  }

  ancestorsOf(userId: string): string[] {
    return ancestors(this.parent, userId, this.maxDepth);
  }

  /** All edges (audit dump for tests). */
  listEdges(): ReferralEdge[] {
    return [...this.parent.entries()].map(([userId, referrerId]) => ({
      userId,
      referrerId,
      attributedAt: this.at.get(userId)!,
    }));
  }

  /**
   * L3 — direct downline count for a referrer (hop-0 only).
   * Does not invent multi-tier expansion as "followers".
   */
  directDownlineCount(referrerId: string): number {
    let n = 0;
    for (const r of this.parent.values()) {
      if (r === referrerId) n += 1;
    }
    return n;
  }

  /** Direct children user ids (hop-0). */
  directDownline(referrerId: string): readonly string[] {
    const out: string[] = [];
    for (const [userId, r] of this.parent.entries()) {
      if (r === referrerId) out.push(userId);
    }
    return out.sort();
  }

  /**
   * L3 — hop-0 downline counts for many referrers in one pass.
   * Unknown referrers → 0 (never invent edges).
   */
  directDownlineCounts(referrerIds: readonly string[]): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of referrerIds) {
      out[id] = 0;
    }
    for (const r of this.parent.values()) {
      if (Object.prototype.hasOwnProperty.call(out, r)) {
        out[r] = (out[r] ?? 0) + 1;
      }
    }
    return out;
  }

  /**
   * L3 — max hop-0 downline among referrers (0 if none / empty input).
   */
  maxDirectDownline(referrerIds: readonly string[]): number {
    const counts = this.directDownlineCounts(referrerIds);
    let max = 0;
    for (const n of Object.values(counts)) {
      if (n > max) max = n;
    }
    return max;
  }

  /**
   * L3 — total attribution edges. Empty tree → 0 (never invent).
   */
  edgeCount(): number {
    return this.parent.size;
  }

  /**
   * L3 — whether user has a referrer set. Unknown user → false.
   */
  hasReferrer(userId: string): boolean {
    const id = userId.trim();
    if (!id) return false;
    return this.parent.has(id);
  }

  /**
   * L3 — unique referrer ids currently in the tree (sorted). Empty → [].
   */
  listReferrerIds(): readonly string[] {
    return [...new Set(this.parent.values())].sort();
  }

  /**
   * L3 — users with a parent (sorted). Empty tree → [] (never invent).
   */
  listAttributedUserIds(): readonly string[] {
    return [...this.parent.keys()].sort();
  }

  /**
   * L3 — referrer of user. None → null (never invent edge).
   */
  referrerOf(userId: string): string | null {
    const id = userId.trim();
    if (!id) return null;
    return this.parent.get(id) ?? null;
  }

  /**
   * L3 — true when user has no parent edge (root or unknown). Empty id → false.
   */
  isRoot(userId: string): boolean {
    const id = userId.trim();
    if (!id) return false;
    return !this.parent.has(id);
  }

  /**
   * L3 — chain depth for user (0 if root). Blank → 0.
   */
  depthOf(userId: string): number {
    const id = userId.trim();
    if (!id) return 0;
    return chainDepth(this.parent, id);
  }

  /**
   * L3 — max chain depth among attributed users. Empty tree → 0.
   */
  maxChainDepth(): number {
    let max = 0;
    for (const userId of this.parent.keys()) {
      const d = chainDepth(this.parent, userId);
      if (d > max) max = d;
    }
    return max;
  }

  /**
   * L3 — number of distinct referrer roots currently used. Empty → 0.
   */
  referrerCount(): number {
    return this.listReferrerIds().length;
  }
}

/** L3 — tree board card from MemoryReferralTree. */
export function referralTreeBoardCard(tree: MemoryReferralTree): {
  readonly edges: number;
  readonly referrers: number;
  readonly maxDepth: number;
} {
  return {
    edges: tree.edgeCount(),
    referrers: tree.referrerCount(),
    maxDepth: tree.maxChainDepth(),
  };
}

/** L3 — tree status line. */
export function referralTreeStatusLine(tree: MemoryReferralTree): string {
  const c = referralTreeBoardCard(tree);
  return `edges=${c.edges} referrers=${c.referrers} maxDepth=${c.maxDepth}`;
}

/** L3 — true when no edges. */
export function referralTreeStatusLineIsEmpty(tree: MemoryReferralTree): boolean {
  return tree.edgeCount() === 0;
}

/** L3 — parse status. Invalid → null. */
export function parseReferralTreeStatusLine(
  line: string,
): { readonly edges: number; readonly referrers: number; readonly maxDepth: number } | null {
  const m = line.trim().match(/^edges=(\d+) referrers=(\d+) maxDepth=(\d+)$/);
  if (!m) return null;
  return { edges: Number(m[1]), referrers: Number(m[2]), maxDepth: Number(m[3]) };
}

/** L3 — true when status matches tree. */
export function referralTreeStatusLineMatches(tree: MemoryReferralTree): boolean {
  const p = parseReferralTreeStatusLine(referralTreeStatusLine(tree));
  if (!p) return false;
  const c = referralTreeBoardCard(tree);
  return p.edges === c.edges && p.referrers === c.referrers && p.maxDepth === c.maxDepth;
}

/** L3 — export header. */
export function referralTreeExportHeader(): string {
  return 'edges,referrers,maxDepth';
}

/** L3 — export line. */
export function referralTreeExportLine(tree: MemoryReferralTree): string {
  const c = referralTreeBoardCard(tree);
  return `${c.edges},${c.referrers},${c.maxDepth}`;
}

/** L3 — full export. */
export function referralTreeExportText(tree: MemoryReferralTree): string {
  return [referralTreeExportHeader(), referralTreeExportLine(tree)].join('\n');
}

/** L3 — true when edge count is within [min,max]. Invalid → false. */
export function referralEdgeCountInRange(tree: MemoryReferralTree, min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = tree.edgeCount();
  return n >= min && n <= max;
}

/** L3 — true when max depth is at most n. */
export function referralMaxDepthAtMost(tree: MemoryReferralTree, n: number): boolean {
  if (!Number.isFinite(n)) return false;
  return tree.maxChainDepth() <= n;
}
