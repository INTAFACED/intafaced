// volt-room: /quant/shared
import { QUANT_TEAM_SHARED } from '@intafaced/contracts/quant-team-procedures';
import { EmptyState } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../shared/resource';
import { ReadView, RecordTable } from '../../shared/record/record-parts';
import { preservePaperHref } from '../more';
import { useApi } from '../session';
import { CopyButton } from '../../screens/account/CopyButton';
import { QuantRooms } from './QuantRooms';
import { teamCopy } from './team-copy';

/** Strategies other people shared with the caller (AL-team-01), and the caller's own sharing ID (their account id) to be added by, with a Copy button. */
export function SharedRoom({ paper }: { paper: boolean }) {
  const api = useApi();
  const { t } = teamCopy.useCopy();
  const list = useResource((signal) => api.call(QUANT_TEAM_SHARED, {}, { signal }), 'quant-shared');
  return (
    <RecordListTemplate
      title={t('sharedTitle')}
      description={t('sharedIntro')}
      state={{ kind: 'ready' }}
      section={<QuantRooms paper={paper} />}
      list={
        <section aria-label={t('sharedTitle')}>
          <div data-testid="quant-shared">
            <ReadView resource={list.resource} retry={list.reload}>
              {(data) => (
                <>
                  <div className="lt-stack" data-testid="quant-my-account-id" data-id={data.accountId}>
                    <strong>{t('yourId')}</strong>
                    <div className="lt-actions">
                      <code lang="zxx">{data.accountId}</code>
                      <CopyButton value={data.accountId} label={t('copyId')} />
                    </div>
                    <p className="lt-hint">{t('yourIdHint')}</p>
                  </div>
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
