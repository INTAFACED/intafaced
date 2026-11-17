import { LAKE_KINDS, coverageOf } from '../lake/lake.js';
import { QUANT_LAKE_RETENTION_UNSET, QUANT_LAKE_STORE_UNSET, QUANT_LAKE_SYMBOL_UNKNOWN, QuantError } from '../errors.js';
import { publicJurisdictionProcedure, quantLakeCatalogueInputSchema, quantLakeCatalogueSchema, router } from '@intafaced/contracts';
import { toTrpc, type QuantCore } from './core.js';

export function lakeRoutes(core: QuantCore) {
  const { deps, now } = core;
  return router({
    catalogue: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantLakeCatalogueInputSchema)
      .output(quantLakeCatalogueSchema)
      .query(async ({ input }) => {
        try {
          const lake = deps.dataLake;
          if (!lake || lake.settings.symbols.length === 0 || lake.settings.captureSeconds === null) {
            throw new QuantError(
              QUANT_LAKE_STORE_UNSET,
              'QUANT_LAKE_SYMBOLS and QUANT_LAKE_CAPTURE_SECONDS — the lake captures nothing on this deployment',
            );
          }
          if (lake.settings.retentionDays === null) {
            throw new QuantError(QUANT_LAKE_RETENTION_UNSET, 'QUANT_LAKE_RETENTION_DAYS — how long the lake keeps a row is not set');
          }
          const { captureSeconds, retentionDays } = lake.settings;
          if (input?.symbol && !lake.settings.symbols.includes(input.symbol)) {
            throw new QuantError(QUANT_LAKE_SYMBOL_UNKNOWN, `the lake does not capture ${input.symbol}`);
          }
          const at = now();
          const keptFrom = new Date(at - retentionDays * 86_400_000).toISOString();
          const symbols = [];
          for (const symbol of lake.settings.symbols) {
            if (input?.symbol && symbol !== input.symbol) continue;
            const [change] = await lake.store.changes(symbol, 1);
            const datasets = [];
            for (const kind of LAKE_KINDS) {
              if (input?.kind && kind !== input.kind) continue;
              const [extent, passes, latest] = await Promise.all([
                lake.store.extent(symbol, kind),
                lake.store.passes(symbol, kind, keptFrom),
                lake.store.latest(symbol, kind, 5),
              ]);
              const { ranges, holes } = coverageOf(passes, captureSeconds);
              datasets.push({
                kind,
                rows: extent.count,
                first: extent.first,
                last: extent.last,
                coverage: ranges,
                gaps: holes,
                latest: latest.map((row) => ({ observedAt: row.observedAt, payload: row.payload })),
              });
            }
            symbols.push({ symbol, capturing: change ? change.capturing : true, datasets });
          }
          return {
            captureSeconds,
            retentionDays,
            keptFrom,
            asOf: new Date(at).toISOString(),
            symbols,
            source: 'INTAFACED exchange public market data' as const,
          };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
