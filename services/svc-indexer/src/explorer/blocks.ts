/**
 * D-explorer-01 (BE core): explorer block facts, owner-bounded list window and
 * utilisation. Blank/unset limit refuses; no invented default. Orphaned blocks
 * are listed with a reason, never hidden.
 */
export const INDEXER_EXPLORER_LIST_LIMIT_UNSET = 'indexer.explorer_list_limit_unset' as const;
export const INDEXER_EXPLORER_LIST_LIMIT_MAX = 200;

export interface ExplorerBlockFact {
  chainId: number;
  height: number;
  hash: string;
  gasUsed: bigint;
  gasLimit: bigint;
  baseFeePerGas: bigint | null;
  miner: string;
  txCount: number;
  size: number;
  timestamp: number;
  orphaned: { reason: string } | null;
}

export type ListLimit = { ok: true; limit: number } | { ok: false; code: typeof INDEXER_EXPLORER_LIST_LIMIT_UNSET };

export function parseExplorerListLimit(raw: string | undefined): ListLimit {
  const t = raw?.trim() ?? '';
  if (!/^\d+$/.test(t)) return { ok: false, code: INDEXER_EXPLORER_LIST_LIMIT_UNSET };
  const n = Number(t);
  if (n < 1 || n > INDEXER_EXPLORER_LIST_LIMIT_MAX) return { ok: false, code: INDEXER_EXPLORER_LIST_LIMIT_UNSET };
  return { ok: true, limit: n };
}

/** gasUsed / gasLimit as a decimal string (6 dp, trailing zeros trimmed); null when the limit is 0. */
export function utilisation(gasUsed: bigint, gasLimit: bigint): string | null {
  if (gasLimit <= 0n) return null;
  const scaled = (gasUsed * 1_000_000n) / gasLimit;
  const int = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${int}.${frac}` : `${int}`;
}

export interface ExplorerBlockRow extends Omit<ExplorerBlockFact, 'gasUsed' | 'gasLimit' | 'baseFeePerGas'> {
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas: string | null;
  utilisation: string | null;
}

export function toRow(f: ExplorerBlockFact): ExplorerBlockRow {
  return {
    ...f,
    gasUsed: f.gasUsed.toString(),
    gasLimit: f.gasLimit.toString(),
    baseFeePerGas: f.baseFeePerGas === null ? null : f.baseFeePerGas.toString(),
    utilisation: utilisation(f.gasUsed, f.gasLimit),
  };
}

/** Descending by height (canonical before orphaned at the same height); cursor = exclusive upper height. */
export function listBlocks(
  facts: readonly ExplorerBlockFact[],
  { limit, cursor }: { limit: number; cursor?: number },
): { rows: ExplorerBlockRow[]; nextCursor: number | null } {
  const heights = [...new Set(facts.map((f) => f.height))].filter((h) => cursor === undefined || h < cursor).sort((a, b) => b - a);
  const page = heights.slice(0, limit);
  const rows = page.flatMap((h) =>
    facts
      .filter((f) => f.height === h)
      .sort((a, b) => Number(a.orphaned !== null) - Number(b.orphaned !== null))
      .map(toRow),
  );
  const nextCursor = heights.length > limit ? page[page.length - 1]! : null;
  return { rows, nextCursor };
}

export const INDEXER_EXPLORER_UNWIRED = 'indexer.explorer_unwired' as const;
export const PROTOCOL_NOT_FOUND = 'protocol.not_found' as const;

/**
 * Rows ordered height DESC (canonical first), fetched with LIMIT limit+1.
 * `allAt` is set when the first `limit` rows all share one height and more
 * rows follow at it: the caller must fetch every row at that height.
 */
export function pageRows(
  rows: readonly ExplorerBlockFact[],
  limit: number,
): { rows: ExplorerBlockFact[]; nextCursor: number | null; allAt?: number } {
  if (rows.length <= limit) return { rows: [...rows], nextCursor: null };
  const cut = rows[limit]!.height;
  // Never split one height across pages: drop the cut height, the next page
  // (height < cut + 1) starts with it.
  const kept = rows.slice(0, limit).filter((r) => r.height !== cut);
  if (kept.length === 0) return { rows: [], nextCursor: cut, allAt: cut };
  return { rows: kept, nextCursor: cut + 1 };
}

/**
 * One list page. When a single height holds more rows than `limit`
 * (canonical + orphans), that page returns every row at the height — over
 * the limit — so no orphan is ever skipped; nextCursor = that height.
 */
export async function listPage(
  source: ExplorerBlocksSource,
  q: { cursor?: number; limit: number },
): Promise<{ rows: ExplorerBlockFact[]; nextCursor: number | null }> {
  const paged = pageRows(await source.blocks(q), q.limit);
  if (paged.allAt === undefined) return { rows: paged.rows, nextCursor: paged.nextCursor };
  const all = await source.atHeight(paged.allAt);
  const more = await source.blocks({ cursor: paged.allAt, limit: 0 });
  return { rows: [...all], nextCursor: more.length > 0 ? paged.allAt : null };
}

/** What the router needs to serve explorer blocks. Absent => `indexer.explorer_unwired`. */
export interface ExplorerBlocksSource {
  readonly listLimit: ListLimit;
  /** WHERE height < cursor ORDER BY height DESC LIMIT limit + 1, for `pageRows`. */
  readonly blocks: (q: { cursor?: number; limit: number }) => Promise<readonly ExplorerBlockFact[]>;
  /** Every row at one height, canonical first. */
  readonly atHeight: (height: number) => Promise<readonly ExplorerBlockFact[]>;
  /** By height (canonical first) or hash; null when not stored. */
  readonly block: (q: { height: number } | { hash: string }) => Promise<ExplorerBlockFact | null>;
}

/** In-memory source over a fact list (tests, memory store). */
export function memoryExplorerSource(listLimit: ListLimit, facts: readonly ExplorerBlockFact[]): ExplorerBlocksSource {
  const ordered = [...facts].sort((a, b) => b.height - a.height || Number(a.orphaned !== null) - Number(b.orphaned !== null));
  return {
    listLimit,
    blocks: async ({ cursor, limit }) => ordered.filter((f) => cursor === undefined || f.height < cursor).slice(0, limit + 1),
    atHeight: async (height) => ordered.filter((f) => f.height === height),
    block: async (q) => ('hash' in q ? ordered.find((f) => f.hash === q.hash) : ordered.find((f) => f.height === q.height)) ?? null,
  };
}
