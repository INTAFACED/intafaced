import type { ChainToken } from '../chain/source.js';

/**
 * D-explorer-03. Token contracts whose transfers are indexed but whose symbol, name and decimals were never read: the
 * ones that emitted only before migration 0003 added the token read, and those past a block's read cap. Ingest reads a
 * token the first time it sees it emit; this sweep reads the rest at the chain's head, in batches, until none is left,
 * and runs again on an interval.
 */
export interface TokenBackfillDeps {
  /** Up to `limit` token addresses with transfers and no stored metadata. */
  readonly unread: (limit: number) => Promise<string[]>;
  /** The contracts' own answers, read at one height. */
  readonly read: (addresses: string[]) => Promise<{ height: number; tokens: ChainToken[] }>;
  /** Stores each answer; an address already stored keeps its first answer. */
  readonly write: (tokens: ChainToken[], height: number) => Promise<void>;
}

export const TOKEN_BACKFILL_BATCH = 50;

/** One pass to the end. Returns how many tokens were read. A failure stops the pass; what was written stays. */
export async function backfillTokenMeta(deps: TokenBackfillDeps): Promise<number> {
  let total = 0;
  for (;;) {
    const addresses = await deps.unread(TOKEN_BACKFILL_BATCH);
    if (addresses.length === 0) return total;
    const { height, tokens } = await deps.read(addresses);
    await deps.write(tokens, height);
    total += tokens.length;
    if (addresses.length < TOKEN_BACKFILL_BATCH) return total;
  }
}

/** Runs the pass at boot and again every `intervalMs` after the last one ended, whether it finished or failed. */
export function startTokenBackfill(
  deps: TokenBackfillDeps,
  log: { info: (data: object, msg: string) => void; warn: (data: object, msg: string) => void },
  intervalMs: number,
): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const again = () => {
    if (!stopped) timer = setTimeout(run, intervalMs);
  };
  const run = () => {
    void backfillTokenMeta(deps)
      .then(
        (read) => {
          if (read > 0) log.info({ read }, 'token metadata backfill finished');
        },
        (err: unknown) => log.warn({ err }, 'token metadata backfill stopped; trying again'),
      )
      .finally(again);
  };
  run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
