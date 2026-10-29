import { useEffect, useState } from 'react';
import { Button, DataTable, EmptyState, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { WALLET_GROUP_ID, WALLET_SECTIONS } from '../routes';
import type { WalletGroup } from './address-book-api';
import { walletCopy } from './copy';
import { bookMessage, useAddressBook, type BookFailure } from './useAddressBook';

type Read = { kind: 'opening' } | { kind: 'ready'; group: WalletGroup } | { kind: 'closed'; failure: BookFailure | null };

/**
 * One wallet group (D-portfolio-wallet-03): its wallets and their combined activity. The activity table keeps its full
 * layout and says what it waits on: the indexer's wallet-activity reader is not built, so no row is shown or made up.
 */
export function WalletGroupPanel({ groupId }: { groupId: string }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const { run, address } = useAddressBook();
  const valid = WALLET_GROUP_ID.test(groupId);
  const [read, setRead] = useState<Read>({ kind: 'opening' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // No wallet shows no group: what a disconnected wallet's group held never stays on screen.
    if (!address) return setRead({ kind: 'opening' });
    if (!valid) return setRead({ kind: 'closed', failure: null });
    let live = true;
    setRead({ kind: 'opening' });
    void run((api, session) => api.group(session, groupId)).then((result) => {
      if (!live) return;
      setRead(result.ok ? { kind: 'ready', group: result.data } : { kind: 'closed', failure: result });
    });
    return () => {
      live = false;
    };
  }, [address, groupId, valid, run, attempt]);

  const group = read.kind === 'ready' ? read.group : null;
  return (
    <>
      <Panel title={group ? group.name : t('groupTitle')}>
        <p className="muted">
          <a href={WALLET_SECTIONS.addressBook}>{t('groupBack')}</a>
        </p>
        {!address && <p className="muted">{t('needsWallet')}</p>}
        {address && read.kind === 'opening' && <p role="status">{t('bookLoading')}</p>}
        {address && read.kind === 'closed' && (
          <>
            <p role="alert">{read.failure ? bookMessage(t, read.failure) : t('groupMissing')}</p>
            {valid && (
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                {t('bookSignIn')}
              </Button>
            )}
          </>
        )}
        <DataTable label={t('groupMembers')} headers={[t('hdr_label'), t('hdr_address')]}>
          {group && group.members.length > 0 ? (
            group.members.map((member) => (
              <tr key={member.address}>
                <td>{member.self ? t('groupThisWallet') : (member.label ?? '')}</td>
                <td className="numeric">{member.address}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={2}>
                <EmptyState title={group ? t('groupNoMembers') : address ? t('bookLoading') : t('needsWallet')} />
              </td>
            </tr>
          )}
        </DataTable>
      </Panel>
      <Panel title={t('groupActivity')}>
        <div data-blocker="indexer">
          <DataTable label={t('groupActivity')} headers={[t('hdr_time'), t('hdr_event'), t('hdr_status')]}>
            <tr>
              <td colSpan={3}>
                <EmptyState title={t('groupActivityEmpty')} />
              </td>
            </tr>
          </DataTable>
        </div>
      </Panel>
    </>
  );
}
