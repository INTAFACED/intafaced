import { z } from 'zod';
import { clobHonesty, clobHonestySchema, type ClobHonesty } from './clob-honesty.js';

/**
 * Health never probes the chain. `status.chain` does.
 *
 * `ok: true, chainId: 31337` sold configured `INDEXER_CHAIN_ID` as a live chain.
 * Process liveness stays `{ ok, service }`. That is not a custody claim.
 * Configured / unprobed is not chain ok — no `chainId` field,
 * `observedChainId` is null. CLOB fixture honesty is unchanged.
 */
export const INDEXER_CHAIN_UNPROBED = 'indexer.chain_unprobed' as const;

const indexerHealthHonestySchema = z.object({
  ok: z.literal(true),
  service: z.literal('svc-indexer'),
  ingestEnabled: z.boolean(),
  clob: clobHonestySchema,
  chain: z.object({
    status: z.literal('unprobed'),
    code: z.literal(INDEXER_CHAIN_UNPROBED),
    observedChainId: z.null(),
  }),
});

export type IndexerHealthHonesty = z.infer<typeof indexerHealthHonestySchema>;

export function indexerHealthHonesty(input: { ingestEnabled: boolean; venue?: string | null }): IndexerHealthHonesty {
  const clob: ClobHonesty = clobHonesty(input.venue);
  return {
    ok: true,
    service: 'svc-indexer',
    ingestEnabled: input.ingestEnabled,
    clob,
    chain: {
      status: 'unprobed',
      code: INDEXER_CHAIN_UNPROBED,
      observedChainId: null,
    },
  };
}
