import { PROTOCOL_AMM_POOL_FEES, PROTOCOL_AMM_REQUEST_PROTOCOL_FEE } from '@intafaced/contracts/protocol-amm-procedures';
import { poolDaySchema, poolsPageSchema, poolSwapsPageSchema, type PoolCursor } from '@intafaced/contracts/indexer-pools';
import type { ProtocolPoolFees } from '@intafaced/contracts/protocol-fees';
import type { ApiClient } from '../../../shared/api';

export * from '@intafaced/contracts/indexer-pools';
export type CandleInterval = '5m' | '1h';

/**
 * An address the owner's factory did not create, as the indexer names it. Only the indexer's own code counts: any other
 * not-found (a gateway or a build without this read) is a refusal to show, never a claim about the address.
 */
export const isNotAPool = (failure: { code?: string; message?: string }) =>
  failure.code === 'indexer.not_a_pool' || failure.message === 'indexer.not_a_pool';

export type PoolFees = ProtocolPoolFees;

/** The protocol service's codes for the Fees panel; a code is matched exactly, never guessed from other text. */
const hasCode = (failure: { code?: string; message?: string }, code: string) =>
  failure.code === code || failure.message === code || (failure.message ?? '').startsWith(`${code}:`);
export const isFeePolicyUnset = (failure: { code?: string; message?: string }) => hasCode(failure, 'protocol.fee_policy_unset');
export const isNotFactoryPool = (failure: { code?: string; message?: string }) => hasCode(failure, 'protocol.not_factory_pool');

export function createPoolsApi(api: ApiClient) {
  return {
    /** The pool's own fee fields, read from the chain by the protocol service: the swap fee and who gets it. */
    fees: (pool: string, signal?: AbortSignal) => api.call(PROTOCOL_AMM_POOL_FEES, { pool }, { signal }),
    /** Asks for a protocol fee on the pool. It moves nothing; with the owner's fee policy blank, it refuses by name. */
    requestProtocolFee: (pool: string) => api.call(PROTOCOL_AMM_REQUEST_PROTOCOL_FEE, { pool }),
    /** The owner factory's pools, newest first, in pages of the owner's list limit. A blank factory refuses by name. */
    list: (chainId: number, signal?: AbortSignal, cursor?: PoolCursor) =>
      api.query('indexer', 'explorer.pools.list', { chainId, ...(cursor ? { cursor } : {}) }, poolsPageSchema, { signal }),
    /** One pool's facts, its last day's volume and swaps, and that day's candles at the asked width. */
    day: (chainId: number, address: string, interval: CandleInterval, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.pools.get', { chainId, address, interval }, poolDaySchema, { signal }),
    /** The pool's swaps, newest first, each a buy or sell from the first token's side. */
    swaps: (chainId: number, address: string, signal?: AbortSignal, cursor?: PoolCursor) =>
      api.query('indexer', 'explorer.pools.swaps', { chainId, address, ...(cursor ? { cursor } : {}) }, poolSwapsPageSchema, { signal }),
  };
}
export type PoolsApi = ReturnType<typeof createPoolsApi>;
