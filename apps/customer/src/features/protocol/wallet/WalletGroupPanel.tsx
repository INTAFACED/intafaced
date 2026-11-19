import { useEffect, useMemo, useState } from 'react';
import { Button, DataTable, EmptyState, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import type { ApiResult } from '../../../shared/api';
import { useApi } from '../../session/session';
import { createExplorerApi } from '../explorer/explorer-api';
import { WALLET_GROUP_ID, WALLET_SECTIONS } from '../routes';
import type { WalletGroup } from './address-book-api';
import { walletCopy } from './copy';
import { APP_CHAIN_ID, shortAddress } from './eip1193';
import { groupActivityRows, type GroupMemberRead } from './group-activity';
import { usePolled } from './use-polled';
import { bookMessage, useAddressBook, type BookFailure } from './useAddressBook';

type Read = { kind: 'opening' } | { kind: 'ready'; group: WalletGroup } | { kind: 'closed'; failure: BookFailure | null };

/**
 * One wallet group (D-portfolio-wallet-03): its wallets and their combined activity, read from our indexer for each
 * wallet of the group and merged newest first. A wallet whose activity could not be read is named, never left out
 * silently.
 */
export function WalletGroupPanel({ groupId }: { groupId: string }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = walletCopy.forLocale(language);
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
  const transport = useApi();
  const explorer = useMemo(() => createExplorerApi(transport), [transport]);
  const nameOf = (member: WalletGroup['members'][number]) =>
    member.self ? t('groupThisWallet') : (member.label ?? shortAddress(member.address));
  const members = group?.members ?? [];
  const membersKey = members.map((member) => member.address.toLowerCase()).join(',');
  const feed = usePolled(
    async (signal): Promise<ApiResult<{ reads: GroupMemberRead[]; refused: { name: string; message: string }[] }> | null> => {
      if (members.length === 0) return null;
      const answers = await Promise.all(members.map((member) => explorer.addressTxs(APP_CHAIN_ID, member.address, signal)));
      const reads: GroupMemberRead[] = [];
      const refused: { name: string; message: string }[] = [];
      answers.forEach((answer, i) => {
        const member = members[i]!;
        if (answer.ok) reads.push({ address: member.address, name: nameOf(member), rows: answer.data.rows });
        else refused.push({ name: nameOf(member), message: answer.message });
      });
      return { ok: true, data: { reads, refused } };
    },
    `group-activity:${groupId}:${membersKey}`,
    3000,
  );
  const activity = feed.data
    ? groupActivityRows(feed.data.reads, {
        sent: (wallet) => t('groupActivitySent', { wallet }),
        received: (wallet) => t('groupActivityReceived', { wallet }),
        call: t('groupActivityCall'),
      })
    : [];
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'medium' });
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
        {feed.data?.refused.map((refusal) => (
          <p role="alert" key={refusal.name}>
            {t('groupActivityRefused', { wallet: refusal.name, message: refusal.message })}
          </p>
        ))}
        <DataTable label={t('groupActivity')} headers={[t('hdr_time'), t('hdr_members'), t('hdr_event'), t('hdr_status'), t('hdr_tx')]}>
          {activity.length > 0 ? (
            activity.map((row) => (
              <tr key={row.hash} data-status={row.status}>
                <td>{when(row.time)}</td>
                <td>{row.wallets.join(', ')}</td>
                <td>{row.what}</td>
                <td>{row.status === 'confirmed' ? t('groupActivityConfirmed') : t('groupActivityFailed')}</td>
                <td className="numeric">
                  <a href={`/chain/tx/${row.hash}`}>{shortAddress(row.hash)}</a>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={5}>
                <EmptyState title={group && !feed.data ? t('groupActivityReading') : t('groupActivityEmpty')} />
              </td>
            </tr>
          )}
        </DataTable>
      </Panel>
    </>
  );
}
