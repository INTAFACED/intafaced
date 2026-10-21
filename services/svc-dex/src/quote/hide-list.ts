import { unwrapTrpcData } from '@intafaced/contracts';
import {
  marketTargetId,
  poolTargetId,
  protocolOpsHiddenOutputSchema,
  type ProtocolOpsHiddenOutput,
} from '@intafaced/contracts/protocol-ops';

/**
 * THE HIDE LIST, READ-ONLY (D-order-controls-04).
 *
 * Which markets INTAFACED does not list is decided by two founders in svc-ops (`protocolListing`). This service only
 * READS the result: it holds no platform credential and no approval, and it never writes. The list is fetched on every
 * quote, never cached, so a delisting takes effect on the next request and there is no staleness to guess at.
 *
 * Fail-closed: a list that cannot be read is a refusal, never an empty list. A missing entry is only "visible" when the
 * list was actually read.
 */

export const HIDE_LIST_UNSET = 'dex.quote.hide_list_unset' as const;
export const HIDE_LIST_UNAVAILABLE = 'dex.quote.hide_list_unavailable' as const;
export const MARKET_HIDDEN = 'dex.quote.market_hidden' as const;
export const POOL_HIDDEN = 'dex.quote.pool_hidden' as const;

export class HideListRefusedError extends Error {
  constructor(
    readonly code: typeof HIDE_LIST_UNSET | typeof HIDE_LIST_UNAVAILABLE | typeof MARKET_HIDDEN | typeof POOL_HIDDEN,
    message: string,
  ) {
    super(message);
    this.name = 'HideListRefusedError';
  }
}

export interface HideListReader {
  read(): Promise<ProtocolOpsHiddenOutput>;
}

export interface HideListOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function createHideListReader(options: HideListOptions): HideListReader {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/trpc/protocolListing.hidden`;
  const unavailable = (why: string) =>
    new HideListRefusedError(HIDE_LIST_UNAVAILABLE, `the hide list could not be read (${why}); no quote is given without it`);
  return {
    async read() {
      let response: Response;
      try {
        response = await doFetch(url, {
          signal: AbortSignal.timeout(options.timeoutMs),
          headers: { accept: 'application/json' },
          redirect: 'error',
        });
      } catch (err) {
        throw unavailable(err instanceof Error ? err.message : 'unreachable');
      }
      if (!response.ok) throw unavailable(`answered ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw unavailable('not JSON');
      }
      const parsed = protocolOpsHiddenOutputSchema.safeParse(unwrapTrpcData(body));
      if (!parsed.success) throw unavailable('not a hide list');
      return parsed.data;
    },
  };
}

/**
 * Throws unless the market was read as visible, and returns the list that was read so the caller can drop hidden pools without a
 * second fetch. `reader` undefined means no source is published at all.
 */
export async function assertMarketListed(reader: HideListReader | undefined, symbol: string): Promise<ProtocolOpsHiddenOutput> {
  if (!reader) {
    throw new HideListRefusedError(
      HIDE_LIST_UNSET,
      'OPS_URL is unpublished, so the hide list cannot be read; no quote is given without it',
    );
  }
  const list = await reader.read();
  const wanted = marketTargetId(symbol);
  if (list.markets.some((m) => marketTargetId(m.symbol) === wanted)) {
    throw new HideListRefusedError(MARKET_HIDDEN, `${wanted} is hidden by INTAFACED and is not quoted`);
  }
  return list;
}

/** The venues left once every venue quoting a hidden pool is dropped. A venue with no `pool` is kept: it cannot be named. */
export function withoutHiddenPools<T extends { readonly pool?: { readonly chainId: number; readonly address: string } }>(
  venues: readonly T[],
  list: ProtocolOpsHiddenOutput,
): readonly T[] {
  const hidden = new Set(list.pools.map((p) => poolTargetId(p.chainId, p.poolAddress)));
  return venues.filter((v) => !v.pool || !hidden.has(poolTargetId(v.pool.chainId, v.pool.address)));
}
