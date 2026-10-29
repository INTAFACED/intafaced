import { useState } from 'react';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useAccountAddressWatches } from './account-lists';
import { WatchShell } from './AddressPage';
import { watchCopy } from './copy';

/**
 * The signed-in account's watched addresses (/chain/watchlist, D-explorer-04): tag and private note per address, read from
 * the account's own record only. An empty list is an empty table and a sentence beside it, never a placeholder row.
 */
export function WatchlistPage() {
  const { language } = usePreferences();
  const { t } = watchCopy.forLocale(language);
  const { list, change } = useAccountAddressWatches();
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<'not-saved' | 'unknown' | null>(null);
  const headers = [t('hdrAddress'), t('hdrTag'), t('hdrNote'), t('hdrActions')];
  let body = null;
  if (list.status === 'signed-out')
    body = (
      <p>
        {t('watchlistSignIn')} <a href="/login">{t('signIn')}</a>
      </p>
    );
  else if (list.status === 'loading') body = <Loading label={t('watchlistTitle')} />;
  else if (list.status === 'failed') body = <Failure result={list.failure} retry={list.reload} />;
  else
    body = (
      <>
        <DataTable label={t('watchlistTitle')} headers={headers}>
          {list.items.map((watch) => (
            <tr key={watch.address}>
              <th scope="row">
                <a href={`/chain/address/${watch.address}`}>{watch.address}</a>
              </th>
              <td>{watch.tag}</td>
              <td>{watch.note}</td>
              <td>
                <Button
                  variant="secondary"
                  disabled={removing !== null}
                  onClick={async () => {
                    setRemoving(watch.address);
                    const write = await change((items) => items.filter((entry) => entry.address !== watch.address));
                    setRemoving(null);
                    setProblem(write === 'saved' ? null : write === 'unknown' ? 'unknown' : 'not-saved');
                  }}
                >
                  {t('remove')}
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
        {list.items.length === 0 && <EmptyState title={t('watchlistEmpty')} />}
        {problem && <p role="alert">{problem === 'unknown' ? t('removeUnknown') : t('removeFailed')}</p>}
      </>
    );
  return (
    <WatchShell title={t('watchlistTitle')} description={t('watchlistDescription')}>
      <Panel title={t('watchlistTitle')}>{body}</Panel>
    </WatchShell>
  );
}
