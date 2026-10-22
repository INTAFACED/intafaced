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

/** gas_used / gas_limit as a decimal string (6 dp, trailing zeros trimmed); null when the limit is 0. */
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
  const heights = [...new Set(facts.map((f) => f.height))]
    .filter((h) => cursor === undefined || h < cursor)
    .sort((a, b) => b - a);
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
