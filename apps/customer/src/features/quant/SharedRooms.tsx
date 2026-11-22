import { QUANT_TEAM_SHARED } from '@intafaced/contracts/quant-team-procedures';
import { useResource } from '../../shared/resource';
import { DataTable, EmptyState, Panel } from '../../shared/ui';
import { Read, preservePaperHref } from '../more';
import { useApi } from '../session';
import { QuantRooms } from './QuantRooms';
import { teamCopy } from './team-copy';
import './algo.css';

/** Strategies other people shared with the caller (AL-team-01), and the caller's own account id to be added by. */
export function SharedRoom({ paper }: { paper: boolean }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const list = useResource((signal) => api.call(QUANT_TEAM_SHARED, {}, { signal }), 'quant-shared');
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <Panel title={t('sharedTitle')}>
        <div data-testid="quant-shared">
          <p className="lt-muted">{t('sharedIntro')}</p>
          <Read resource={list.resource} retry={list.reload}>
            {(data) => (
              <>
                <p data-testid="quant-my-account-id" data-id={data.accountId}>
                  {t('yourId', { id: data.accountId })}
                </p>
                <p className="lt-muted">{t('yourIdHint')}</p>
                {data.strategies.length === 0 ? (
                  <EmptyState title={t('noShared')} />
                ) : (
                  <DataTable label={t('sharedTitle')} headers={[t('name'), t('version'), t('permission'), t('owner'), '']}>
                    {data.strategies.map((row) => (
                      <tr key={row.strategyId} data-testid="quant-shared-row" data-id={row.strategyId} data-role={row.role}>
                        <td lang="und">{row.name}</td>
                        <td>{t('versionOf', { version: row.version })}</td>
                        <td>{t(row.role)}</td>
                        <td lang="zxx">{row.ownerId}</td>
                        <td>
                          <a className="lt-link" href={preservePaperHref(`/quant/shared/${encodeURIComponent(row.strategyId)}`, paper)}>
                            {t('open', { name: row.name })}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                )}
              </>
            )}
          </Read>
        </div>
      </Panel>
    </>
  );
}
