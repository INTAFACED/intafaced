// hand-declared-ok: svc-token's buybackRuns output is declared in its router; packages/contracts has no token schemas yet
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { DataTable, EmptyState, Panel } from '../../shared/ui';
import { Read } from './common';
import { buybackRunsCopy } from './buyback-runs-copy';

const iso = z.string().datetime({ offset: true });
const bps = z.number().int().min(0).max(10_000);
const run = z
  .object({
    id: z.string().min(1),
    bought: decimalSchema,
    burned: decimalSchema,
    toRewards: decimalSchema,
    executedAt: iso,
    windowFrom: iso,
    windowTo: iso,
  })
  .refine((r) => parseAmount(r.bought) === parseAmount(r.burned) + parseAmount(r.toRewards), 'buyback run does not add up');

/** The token service's `buybackRuns` read. A run that does not add up fails the read; it is never drawn. */
export const buybackRunsSchema = z.object({
  job: z.enum(['set', 'unset']),
  runs: z.array(run),
  rate: z.object({ buybackBps: bps, burnSplitBps: bps }).nullable(),
  missing: z.string().nullable(),
  reason: z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']).nullable(),
});

const LIMIT = 50;

export type BuybackRunsRead = z.infer<typeof buybackRunsSchema>;

/** Stored buyback runs, the job's state and the rate, read from the token service. */
export function BuybackRuns() {
  const api = useApi();
  const { userId } = useSession();
  const read = useResource(
    (signal) => api.query('token', 'buybackRuns', { limit: LIMIT }, buybackRunsSchema, { signal }),
    `token-buyback-runs:${userId}`,
  );
  return <BuybackRunsView read={read} />;
}

/** No amount is estimated: the job sizes a run only when it runs. */
export function BuybackRunsView({ read }: { read: { resource: Resource<BuybackRunsRead>; reload: () => void } }) {
  const { hideBalances } = usePreferences();
  const { Copy, t } = buybackRunsCopy.useCopy();
  const shown = (value: string) => (hideBalances ? '••••' : displayAmount(value));
  return (
    <Panel title={t('runsTitle')}>
      <p className="muted">
        <Copy k="runsBody" />
      </p>
      <Read resource={read.resource} retry={read.reload}>
        {(data) => (
          <>
            <p role="status" data-testid="buyback-job">
              {data.job === 'set' ? t('jobSet') : t('jobUnset')}
            </p>
            <DataTable headers={[t('executed'), t('window'), t('bought'), t('burned'), t('toRewards')]} label={t('runsTitle')}>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.executedAt}</td>
                  <td>{t('windowRange', { from: r.windowFrom, to: r.windowTo })}</td>
                  <td className="numeric">{shown(r.bought)}</td>
                  <td className="numeric">{shown(r.burned)}</td>
                  <td className="numeric">{shown(r.toRewards)}</td>
                </tr>
              ))}
            </DataTable>
            {data.runs.length === 0 && <EmptyState title={t('noRuns')} />}
            <p data-testid="buyback-estimate">
              {data.rate
                ? t('estimateRate', { buyback: data.rate.buybackBps, burn: data.rate.burnSplitBps })
                : data.reason === 'token.params_invalid'
                  ? t('estimateInvalid')
                  : t('estimateUnset')}
            </p>
          </>
        )}
      </Read>
    </Panel>
  );
}
