import { TOKEN_BUYBACK_RUNS } from '@intafaced/contracts/token-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { useApi, useSession } from '../session';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount, parseAmount } from '../../shared/money';
import { usePreferences } from '../../shared/preferences';
import { DataTable, EmptyState, Panel } from '../../shared/ui';
import { Read } from './common';
import { buybackRunsCopy } from './buyback-runs-copy';

export type BuybackRunsRead = ProcedureOutput<typeof TOKEN_BUYBACK_RUNS>;

/** This room's check on the read: a run that does not add up (bought = burned + to rewards) fails it, so it is never drawn. */
export const buybackRunsAddUp = (read: BuybackRunsRead): boolean =>
  read.runs.every((r) => parseAmount(r.bought) === parseAmount(r.burned) + parseAmount(r.toRewards));

const LIMIT = 50;

/** An ISO instant as minutes in UTC. */
const utc = (at: string) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Stored buyback runs, the job's state and the rate, read from the token service. */
export function BuybackRuns() {
  const api = useApi();
  const { userId } = useSession();
  const read = useResource(
    (signal) => api.call(TOKEN_BUYBACK_RUNS, { limit: LIMIT }, { signal, accept: buybackRunsAddUp }),
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
      <p className="lt-muted">
        <Copy k="runsBody" /> {t('latest', { limit: LIMIT })}
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
                  <td>
                    <time dateTime={r.executedAt}>{utc(r.executedAt)}</time>
                  </td>
                  <td>{t('windowRange', { from: utc(r.windowFrom), to: utc(r.windowTo) })}</td>
                  <td className="lt-num">{shown(r.bought)}</td>
                  <td className="lt-num">{shown(r.burned)}</td>
                  <td className="lt-num">{shown(r.toRewards)}</td>
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
