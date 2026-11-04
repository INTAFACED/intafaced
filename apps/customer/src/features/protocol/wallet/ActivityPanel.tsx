import { useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import type { ProtocolReplacement } from '@intafaced/contracts/protocol-wallet-tx';
import { Button, DataTable, Dialog, EmptyState, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { createExplorerApi, type ExplorerAddressTxsPage } from '../explorer/explorer-api';
import { walletCopy } from './copy';
import { APP_CHAIN_ID, shortAddress } from './eip1193';
import { RepresentationPanel } from './RepresentationPanel';
import { readSent, recordSent, type SentRecord } from './sent-store';
import { signingGate, type SigningGate } from './signing-gate';
import { toHexValue } from './transfer';
import { transfersCopy } from './transfers-copy';
import { usePolled } from './use-polled';
import { useWallet } from './WalletProvider';

type Status = 'pending' | 'confirmed' | 'failed' | 'replaced' | 'dropped' | 'unread';
export interface ActivityRow {
  hash: string;
  /** Unix seconds: the block's time, or when this browser sent it while it is not in a block yet. */
  time: number;
  what: string;
  status: Status;
  replacedBy: string | null;
  /** Sent by this wallet (so only it could replace it). */
  mine: boolean;
  spam: boolean;
}
type IndexedRow = ExplorerAddressTxsPage['rows'][number];
type Lookup = { hash: string; status: 'pending' | 'success' | 'failed' | 'dropped' | 'replaced' | 'unknown'; replacingHash: string | null };

const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/**
 * Spam (D-portfolio-wallet-03): a transaction someone else sent that only brought this wallet tokens no pool on this
 * network lists, the usual unasked airdrop. The token-listing flags of D-launch-listing-02 are not built yet; this is
 * the rule until they are. It is a view filter: the row is hidden, never deleted, and "Show spam" brings it back.
 */
export function isSpam(row: IndexedRow, me: string, listed: ReadonlySet<string> | null): boolean {
  // Without the pool list nothing is called spam: an unread list never hides a real transfer.
  if (listed === null || same(row.from, me) || row.transfers.length === 0) return false;
  return row.transfers.every((transfer) => transfer.direction === 'in' && !listed.has(transfer.token.address.toLowerCase()));
}

/** The rows Activity shows, newest first: the indexer's, then this browser's sends it has not read yet. */
export function activityRows(
  indexed: readonly IndexedRow[],
  sent: readonly SentRecord[],
  lookups: readonly Lookup[],
  me: string,
  listed: ReadonlySet<string> | null,
  words: { sent: string; received: string; call: string },
): ActivityRow[] {
  const byHash = new Map(lookups.map((lookup) => [lookup.hash.toLowerCase(), lookup]));
  const rows: ActivityRow[] = indexed.map((row) => {
    const local = sent.find((record) => same(record.hash, row.hash));
    const transfers = row.transfers.map((transfer) => {
      const amount = transfer.token.decimals === null ? transfer.amount : formatUnits(BigInt(transfer.amount), transfer.token.decimals);
      const token = transfer.token.symbol ?? shortAddress(transfer.token.address);
      return `${transfer.direction === 'in' ? words.received : words.sent} ${amount} ${token}`;
    });
    return {
      hash: row.hash,
      time: row.timestamp,
      what: transfers.length > 0 ? transfers.join('; ') : (local?.label ?? words.call),
      status: row.status === 'success' ? 'confirmed' : 'failed',
      replacedBy: null,
      mine: same(row.from, me),
      spam: isSpam(row, me, listed),
    };
  });
  for (const record of sent) {
    if (rows.some((row) => same(row.hash, record.hash))) continue;
    const lookup = byHash.get(record.hash.toLowerCase());
    // Only sends this read asked the network about are listed; older ones are on later pages of the indexer's list.
    if (!lookup) continue;
    const replacement = sent.find((other) => same(other.replaces, record.hash));
    const replacementSeen =
      replacement &&
      (rows.some((row) => same(row.hash, replacement.hash)) ||
        ['success', 'failed'].includes(byHash.get(replacement.hash.toLowerCase())?.status ?? ''));
    let status: Status;
    let replacedBy: string | null = null;
    if (lookup?.status === 'pending') status = 'pending';
    else if (lookup?.status === 'success') status = 'confirmed';
    else if (lookup?.status === 'failed') status = 'failed';
    else if (lookup?.status === 'replaced' || replacementSeen) {
      status = 'replaced';
      replacedBy = lookup?.replacingHash ?? replacement?.hash ?? null;
    } else if (lookup.status === 'dropped') status = 'dropped';
    // The network did not answer for it on this read: said plainly, never guessed as dropped or done.
    else status = 'unread';
    rows.push({
      hash: record.hash,
      time: Math.floor(record.sentAt / 1000),
      what: record.label ?? words.call,
      status,
      replacedBy,
      mine: true,
      spam: false,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/** A CSV of exactly the rows given, header first. Every field is quoted. */
export function activityCsv(rows: readonly ActivityRow[], statusWords: (row: ActivityRow) => string): string {
  // A cell a spreadsheet would run as a formula (a token's symbol is chosen by whoever made it) starts with ' instead.
  const quote = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const lines = [['Transaction', 'Time (UTC)', 'What', 'Status'].map(quote).join(',')];
  for (const row of rows) lines.push([row.hash, new Date(row.time * 1000).toISOString(), row.what, statusWords(row)].map(quote).join(','));
  return `${lines.join('\n')}\n`;
}

type Sheet = { mode: 'speedUp' | 'cancel'; row: ActivityRow };
type Built = { status: 'loading' } | { status: 'ready'; plan: ProtocolReplacement } | { status: 'refused'; message: string };

/**
 * /wallet/activity (D-portfolio-wallet-03, RC-dex-protocol-01): this wallet's transactions from our indexer, with the
 * ones this browser sent that are not in a block yet. Failed and spam rows are hidden until their toggles show them; the
 * count and the export follow exactly what is shown. A pending transaction this wallet sent can be sped up or canceled
 * with a same-nonce replacement; a mined one is final.
 */
export function ActivityPanel() {
  const { language } = usePreferences();
  const { t: tw } = walletCopy.forLocale(language);
  const { t, renderedLocale } = transfersCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const explorer = useMemo(() => createExplorerApi(transport), [transport]);
  const pairs = useResource((signal) => api.ammPairs(signal), 'activity:pairs');
  const listed = useMemo(
    () => (pairs.resource.status === 'ready' ? new Set(pairs.resource.data.tokens.map((token) => token.address.toLowerCase())) : null),
    [pairs.resource],
  );
  const me = wallet.status === 'connected' ? wallet.address : null;
  const [showFailed, setShowFailed] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [built, setBuilt] = useState<Built>({ status: 'loading' });
  const [notice, setNotice] = useState<{ role: 'status' | 'alert'; text: string } | null>(null);
  const [gate, setGate] = useState<{ needed: Extract<SigningGate, { kind: 'needed' }>; resume: () => void } | null>(null);

  const feed = usePolled(
    async (signal): Promise<ApiResult<{ page: ExplorerAddressTxsPage; sent: SentRecord[]; lookups: Lookup[] }> | null> => {
      if (!me) return null;
      const page = await explorer.addressTxs(APP_CHAIN_ID, me, signal);
      if (!page.ok) return page;
      const sent = readSent(APP_CHAIN_ID, me);
      const unread = sent.filter((record) => !page.data.rows.some((row) => same(row.hash, record.hash))).slice(0, 10);
      const lookups = await Promise.all(
        unread.map(async (record): Promise<Lookup> => {
          const answer = await explorer.tx(APP_CHAIN_ID, record.hash, signal);
          return answer.ok
            ? { hash: record.hash, status: answer.data.status, replacingHash: answer.data.replacingHash }
            : { hash: record.hash, status: 'unknown', replacingHash: null };
        }),
      );
      return { ok: true, data: { page: page.data, sent, lookups } };
    },
    `activity:${me ?? 'none'}`,
    2000,
  );

  const rows = feed.data
    ? activityRows(feed.data.page.rows, feed.data.sent, feed.data.lookups, me ?? '', listed, {
        sent: t('activitySent'),
        received: t('activityReceived'),
        call: t('activityCall'),
      })
    : [];
  const visible = rows.filter((row) => (showFailed || row.status !== 'failed') && (showSpam || !row.spam));
  const statusWords = (row: ActivityRow) =>
    row.status === 'pending'
      ? t('activityPending')
      : row.status === 'confirmed'
        ? t('activityConfirmed')
        : row.status === 'failed'
          ? t('activityFailed')
          : row.status === 'replaced'
            ? t('activityReplaced', { hash: row.replacedBy ? shortAddress(row.replacedBy) : '' })
            : row.status === 'dropped'
              ? t('activityDropped')
              : t('activityUnread');
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'medium' });

  const exportRows = () => {
    const blob = new Blob([activityCsv(visible, statusWords)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wallet-activity-${(me ?? 'wallet').slice(0, 10)}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const refusalText = (code: string | undefined, message: string) =>
    code === 'protocol.tx_final' ? t('sheetRefused_final') : t('sheetRefused_other', { message });

  const build = (next: Sheet) =>
    me
      ? api.buildReplacement({ txHash: next.row.hash, from: me, mode: next.mode })
      : Promise.resolve({ ok: false as const, reason: 'error' as const, message: tw('signNotConnected'), code: undefined });

  const openSheet = async (next: Sheet) => {
    setNotice(null);
    setSheet(next);
    setBuilt({ status: 'loading' });
    const plan = await build(next);
    setBuilt(plan.ok ? { status: 'ready', plan: plan.data } : { status: 'refused', message: refusalText(plan.code, plan.message) });
  };

  /** The nonce the network shows for a hash just sent, read through our indexer; null when it does not answer in time. */
  const sentNonce = async (hash: string): Promise<number | null> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const answer = await explorer.tx(APP_CHAIN_ID, hash);
      if (answer.ok && answer.data.transaction) return answer.data.transaction.nonce;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  };

  const send = async (plan: ProtocolReplacement, replaces: string) => {
    if (!me) return;
    const result = await wallet.sign({
      kind: 'transaction',
      to: plan.to,
      value: toHexValue(BigInt(plan.value)),
      data: plan.data,
      maxFeePerGas: toHexValue(BigInt(plan.replacement.maxFeePerGas)),
      maxPriorityFeePerGas: toHexValue(BigInt(plan.replacement.maxPriorityFeePerGas)),
      nonce: toHexValue(BigInt(plan.nonce)),
      gas: toHexValue(BigInt(plan.gas)),
    });
    if (result.status === 'sent') {
      const original = readSent(APP_CHAIN_ID, me).find((record) => same(record.hash, replaces));
      const label = plan.mode === 'cancel' ? t('sheetCancel') : (original?.label ?? t('activityCall'));
      // Some wallets ignore a requested nonce. Only a transaction the network shows at the planned nonce replaces the
      // first one; anything else is recorded as a send of its own and the person is told both may happen.
      const nonce = await sentNonce(result.hash);
      if (nonce === plan.nonce) {
        recordSent(APP_CHAIN_ID, me, { hash: result.hash, sentAt: Date.now(), kind: plan.mode, replaces, label });
        setNotice({ role: 'status', text: t('sheetSent', { hash: result.hash }) });
      } else {
        recordSent(APP_CHAIN_ID, me, { hash: result.hash, sentAt: Date.now(), kind: 'other', label });
        setNotice({
          role: 'alert',
          text: t('activityOtherNonce', { got: nonce === null ? '?' : String(nonce), want: String(plan.nonce) }),
        });
      }
      feed.reload();
    } else if (result.status === 'failed') setNotice({ role: 'alert', text: t('sheetRefused_other', { message: result.message }) });
  };

  /** Continue: the plan is built again from the chain, so a transaction mined while the sheet was open is refused as final. */
  const confirm = async () => {
    if (!sheet || !me) return;
    const current = sheet;
    setBuilt({ status: 'loading' });
    const fresh = await build(current);
    if (!fresh.ok) return setBuilt({ status: 'refused', message: refusalText(fresh.code, fresh.message) });
    setSheet(null);
    const plan = fresh.data;
    const outcome = await signingGate(api, me);
    if (outcome.kind === 'refused') return setNotice({ role: 'alert', text: tw(outcome.key) });
    if (outcome.kind === 'needed') return setGate({ needed: outcome, resume: () => void send(plan, current.row.hash) });
    await send(plan, current.row.hash);
  };

  const gwei = (wei: string) => `${formatUnits(BigInt(wei), 9)} gwei`;
  const headers = [t('activityHash'), t('activityTime'), t('activityWhat'), t('activityStatus'), t('activityActions')];

  return (
    <>
      {gate && (
        <RepresentationPanel
          address={gate.needed.address}
          status={gate.needed.status}
          api={api}
          onEnd={(end) => {
            const resume = gate.resume;
            setGate(null);
            if (end.kind === 'accepted') resume();
            else if (end.kind === 'region') setNotice({ role: 'alert', text: tw('permitRefused_region') });
            else if (end.kind === 'rejected') setNotice({ role: 'alert', text: t('sheetRefused_other', { message: tw('sendRejected') }) });
            else setNotice({ role: 'alert', text: t('sheetRefused_other', { message: end.message }) });
          }}
        />
      )}
      <Panel title={tw('section_activity')}>
        {wallet.status !== 'connected' && <p className="muted">{tw('needsWallet')}</p>}
        <div className="protocol-actions" data-activity-filters>
          <label className="field field--check">
            <input type="checkbox" checked={showFailed} onChange={(event) => setShowFailed(event.target.checked)} />
            <span>{t('activityShowFailed')}</span>
          </label>
          <label className="field field--check">
            <input type="checkbox" checked={showSpam} onChange={(event) => setShowSpam(event.target.checked)} />
            <span>{t('activityShowSpam')}</span>
          </label>
          <span data-testid="activity-count" aria-live="polite">
            {t('activityShown', { count: String(visible.length) })}
          </span>
          <Button variant="secondary" disabled={!feed.data} onClick={exportRows}>
            {t('activityExport')}
          </Button>
        </div>
        <p className="muted">{t('activitySpamNote')}</p>
        {feed.data?.page.asOfHeight !== null && feed.data?.page.asOfHeight !== undefined && (
          <p className="muted">{t('activityAsOf', { block: String(feed.data.page.asOfHeight) })}</p>
        )}
        {feed.failure && (
          <p role="note" data-code={feed.failure.code}>
            {t('activityRefused', { message: feed.failure.message })}
          </p>
        )}
        {notice && <p role={notice.role}>{notice.text}</p>}
        <DataTable label={tw('section_activity')} headers={headers}>
          {visible.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>
                <EmptyState title={tw('empty_activity')} />
              </td>
            </tr>
          ) : (
            visible.map((row) => (
              <tr key={row.hash} data-activity-row={row.hash.toLowerCase()} data-status={row.status}>
                <td className="numeric">
                  <a href={`/chain/tx/${row.hash}`}>{shortAddress(row.hash)}</a>
                </td>
                <td>{when(row.time)}</td>
                <td>
                  {row.what}
                  {row.spam && <span className="badge"> {t('activitySpam')}</span>}
                </td>
                <td>{statusWords(row)}</td>
                <td>
                  {row.status === 'pending' && row.mine && (
                    <>
                      <Button variant="secondary" onClick={() => void openSheet({ mode: 'speedUp', row })}>
                        {t('speedUp')}
                      </Button>{' '}
                      <Button variant="secondary" onClick={() => void openSheet({ mode: 'cancel', row })}>
                        {t('cancel')}
                      </Button>
                    </>
                  )}
                  {(row.status === 'confirmed' || row.status === 'failed') && <span className="muted">{t('activityFinal')}</span>}
                </td>
              </tr>
            ))
          )}
        </DataTable>
      </Panel>
      {sheet && (
        <Dialog title={sheet.mode === 'speedUp' ? t('sheetSpeedUp') : t('sheetCancel')} onClose={() => setSheet(null)}>
          <p>{t('sheetSameNonce')}</p>
          {built.status === 'loading' && <p role="status">{t('sheetChecking')}</p>}
          {built.status === 'refused' && <p role="alert">{built.message}</p>}
          {built.status === 'ready' && (
            <>
              <p>
                {sheet.mode === 'speedUp'
                  ? t('sheetSpeedUpWhat', { nonce: String(built.plan.nonce) })
                  : t('sheetCancelWhat', { nonce: String(built.plan.nonce) })}
              </p>
              <dl className="protocol-facts">
                <div>
                  <dt>{t('sheetOldFee')}</dt>
                  <dd className="numeric" data-fee="old-max">
                    {gwei(built.plan.original.maxFeePerGas)}
                  </dd>
                </div>
                <div>
                  <dt>{t('sheetNewFee')}</dt>
                  <dd className="numeric" data-fee="new-max">
                    {gwei(built.plan.replacement.maxFeePerGas)}
                  </dd>
                </div>
                <div>
                  <dt>{t('sheetOldTip')}</dt>
                  <dd className="numeric">{gwei(built.plan.original.maxPriorityFeePerGas)}</dd>
                </div>
                <div>
                  <dt>{t('sheetNewTip')}</dt>
                  <dd className="numeric">{gwei(built.plan.replacement.maxPriorityFeePerGas)}</dd>
                </div>
              </dl>
              <p className="muted">
                {t('sheetBump', { percent: String(built.plan.bumpBps / 100), ceiling: formatUnits(BigInt(built.plan.ceilingWei), 9) })}
              </p>
            </>
          )}
          <div className="protocol-actions">
            <Button variant="secondary" onClick={() => setSheet(null)}>
              {t('sheetBack')}
            </Button>
            <Button disabled={built.status !== 'ready'} onClick={() => void confirm()}>
              {t('sheetContinue')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
