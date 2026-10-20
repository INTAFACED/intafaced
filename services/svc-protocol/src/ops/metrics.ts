import type { BlockerSource, ProtocolOpsMetricsOutput, DexHealth, IndexerStatus } from '@intafaced/contracts';

/**
 * Metrics for the Protocol ops desk. A source that cannot be read is `could_not_load` with the time tried, never a zero.
 *
 * Quote counts, refusal counts by code and distinct quote wallets are svc-dex's to count, and svc-dex publishes no such read
 * yet, so they read `protocol.ops_source_unavailable` here. Indexer lag and per-section health come from the peers this
 * service already reads for `blockers`.
 */
export const OPS_SOURCE_UNAVAILABLE = 'protocol.ops_source_unavailable';

export function buildMetrics(input: {
  now: Date;
  windowSeconds: number;
  indexer: BlockerSource<IndexerStatus>;
  dex: BlockerSource<DexHealth>;
  chainReachable: boolean | null;
}): ProtocolOpsMetricsOutput {
  const at = input.now.toISOString();
  const from = new Date(input.now.getTime() - input.windowSeconds * 1000).toISOString();
  const unavailable = { status: 'could_not_load', triedAt: at, code: OPS_SOURCE_UNAVAILABLE } as const;
  const peerHealth = (source: BlockerSource<unknown>) => (source.status === 'ok' ? 'ok' : source.status === 'down' ? 'down' : 'unknown');
  const lag: ProtocolOpsMetricsOutput['indexerLagBlocks'] =
    input.indexer.status === 'ok'
      ? { status: 'ok', value: input.indexer.data.behindBy }
      : {
          status: 'could_not_load',
          triedAt: at,
          code: input.indexer.status === 'down' ? (input.indexer.code ?? input.indexer.reason) : 'loading',
        };
  const health = (section: ProtocolOpsMetricsOutput['sections'][number]['section'], h: 'ok' | 'degraded' | 'down' | 'unknown') => ({
    section,
    health: h,
    checkedAt: at,
  });
  return {
    asOf: at,
    window: { from, to: at },
    quotes: unavailable,
    wallets: unavailable,
    refusalsByCode: unavailable,
    indexerLagBlocks: lag,
    sections: [
      health('chain', input.chainReachable === null ? 'unknown' : input.chainReachable ? 'ok' : 'down'),
      health('audit', 'ok'),
      health('indexer', peerHealth(input.indexer)),
      health('dex', peerHealth(input.dex)),
      health('blockers', 'ok'),
      health('contracts', 'ok'),
      health('metrics', 'ok'),
      health('labels', 'ok'),
    ],
  };
}
