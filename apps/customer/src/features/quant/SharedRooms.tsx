// volt-room: /quant/shared
import { QUANT_TEAM_SHARED } from '@intafaced/contracts/quant-team-procedures';
import { EmptyState } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { ReadView, RecordTable } from '../../shared/record/record-parts';
import { preservePaperHref } from '../more';
import { useApi } from '../session';
import { QuantRooms } from './QuantRooms';
import { teamCopy } from './team-copy';

/** Strategies other people shared with the caller (AL-team-01), and the caller's own account id to be added by. */
export function SharedRoom({ paper }: { paper: boolean }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const list = useResource((signal) => api.call(QUANT_TEAM_SHARED, {}, { signal }), 'quant-shared');
  return (
    <RecordListTemplate
      title={t('sharedTitle')}
      description={t('sharedIntro')}
      state={{ kind: 'ready' }}
      filters={<QuantRooms active="strategies" paper={paper} />}
      list={
        <section>
          <h2>{t('sharedTitle')}</h2>
          <div data-testid="quant-shared">
            <p className="lt-hint">{t('sharedIntro')}</p>
            <ReadView resource={list.resource} retry={list.reload}>
              {(data) => (
                <>
                  <p data-testid="quant-my-account-id" data-id={data.accountId}>
                    {t('yourId', { id: data.accountId })}
                  </p>
                  <p className="lt-hint">{t('yourIdHint')}</p>
                  {data.strategies.length === 0 ? (
                    <EmptyState title={t('noShared')} />
                  ) : (
                    <RecordTable label={t('sharedTitle')} headers={[t('name'), t('version'), t('permission'), t('owner'), '']}>
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
                    </RecordTable>
                  )}
                </>
              )}
            </ReadView>
          </div>
        </section>
      }
    />
  );
}
