// volt-room: /money/balance/:asset
import { ArrowLeft, Check } from 'lucide-react';
import { Amount, Button, Segmented, StateBlock } from '@intafaced/ui/lit';
import { RecordListTemplate, Skeleton, type RoomState } from '@intafaced/ui/lit/templates';
import { fmtAmount, navigate, refusalCopy } from './deps';
import { moneyCopy } from './copy';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';
import { assetFromPath, balanceEntriesHref, accountFromSearch, feeIsZero, signedOf, type BalanceEntryRow } from './balance-entries-model';
import { useBalanceEntries } from './balance-entries-source';
import { useNamedAccounts } from './portfolio-source';
import { SetAside } from './SetAside';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** The switch's value for every account at once (no `account` in the address). */
const ALL = '*all';
const READY: RoomState = { kind: 'ready' };

const accountLabel = (accountId: string, names: ReadonlyMap<string, string>, copy: Copy) =>
  accountId === 'main' ? copy.t('Entries main account') : (names.get(accountId) ?? copy.t('Entries other account'));

function Row({
  row,
  hidden,
  zone,
  names,
  asset,
}: {
  asset: string;
  row: BalanceEntryRow;
  hidden: boolean;
  zone: ReturnType<typeof usePreferences>['timeZone'];
  names: ReadonlyMap<string, string>;
}) {
  const copy = moneyCopy.useCopy();
  const signed = signedOf(row);
  const up = row.direction === 'debit';
  const amountClass = up ? 'lt-up' : 'lt-down';
  return (
    <tr>
      <td>
        <time dateTime={row.postedAt}>{stamp(row.postedAt, zone)}</time>
      </td>
      <td>{up ? copy.t('Money in direction') : copy.t('Money out direction')}</td>
      <td>{accountLabel(row.accountId, names, copy)}</td>
      <td className="lt-num">
        <Amount value={signed === null ? '—' : `${up ? '+' : '−'}${fmtAmount(row.amount)}`} hidden={hidden} className={amountClass} />
      </td>
      <td>
        <code className="lt-mono">{row.txId}</code>
      </td>
      <td data-testid="entry-state">{row.state === 'completed' ? copy.t('Completed') : '—'}</td>
      <td data-testid="entry-fee">
        {row.fee == null ? (
          copy.t('Entries fee unknown')
        ) : feeIsZero(row.fee) ? (
          copy.t('No fee')
        ) : (
          <Amount value={`${fmtAmount(row.fee)} ${asset}`} hidden={hidden} />
        )}
      </td>
    </tr>
  );
}

/** The ledger entries behind one coin's spendable balance (PF-balances-01), with the bank's sum check on top. */
export default function BalanceEntries({ rawAsset, search }: { rawAsset: string; search: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, timeZone } = usePreferences();
  const asset = assetFromPath(rawAsset);
  const accountId = accountFromSearch(search);
  const state = useBalanceEntries(asset, accountId);
  const named = useNamedAccounts();
  const spaces = named.status === 'ready' ? named.data : [];
  const names = new Map(spaces.map((space) => [space.id, space.name]));

  let body: React.ReactNode;
  if (asset === '') {
    body = (
      <StateBlock
        kind="empty"
        title={t('No entries for this coin', { asset: '' })}
        action={{ label: t('Back to your money'), href: '/money' }}
      />
    );
  } else if (state.status === 'loading') {
    body = (
      <div aria-busy="true" role="status" aria-label={t('Loading entries')} className="lt-stack">
        <Skeleton shape="rows" count={3} />
      </div>
    );
  } else if (state.status === 'error') {
    body = <StateBlock kind="error" title={t('Couldn’t load these entries')} onRetry={state.retry} retryLabel={t('Try again')} />;
  } else if (state.status === 'refused') {
    const words = refusalCopy(state.code);
    // The bank names the gap; it is money, so it is not shown while balances are hidden.
    const detail = state.detail && !hideBalances ? ` ${state.detail}.` : '';
    body = <StateBlock kind="refused" title={words.title} body={`${words.body}${detail}`} code={words.reference} action={words.action} />;
  } else if (state.rows.length === 0) {
    body = (
      <StateBlock kind="empty" title={t('No entries for this coin', { asset })} body={t('No entries for this coin body', { asset })} />
    );
  } else {
    body = (
      <>
        <p className="lt-hint" role="status">
          <span data-testid="money-act__done" className="lt-chip">
            <Check size={14} aria-hidden="true" />
            {t('Entries check label')}
          </span>
          <span aria-hidden="true"> · </span>
          {hideBalances
            ? t('Entries add up', { count: String(state.check.entryCount), balance: '••••', asset })
            : t('Entries add up', {
                count: String(state.check.entryCount),
                balance: fmtAmount(state.check.balance, { round: 'down' }),
                asset,
              })}
        </p>
        <section data-testid="money-card" className="lt-table-scroll" aria-label={t('Balance entries title', { asset })}>
          <table data-testid="money-table" className="lt-table">
            <thead>
              <tr>
                <th scope="col">{t('Entries column when')}</th>
                <th scope="col">{t('Entries column what')}</th>
                <th scope="col">{t('Entries column account')}</th>
                <th scope="col" className="lt-num">
                  {t('Entries column amount')}
                </th>
                <th scope="col">{t('Entries column reference')}</th>
                <th scope="col">{t('Entries column state')}</th>
                <th scope="col">{t('Entries column fee')}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <Row
                  key={`${row.accountId}:${row.txId}:${row.entryId ?? row.direction + row.amount}`}
                  row={row}
                  hidden={hideBalances}
                  zone={timeZone}
                  names={names}
                  asset={asset}
                />
              ))}
            </tbody>
          </table>
        </section>
        {state.moreFailed && <p className="lt-hint">{t('Couldn’t load more')}</p>}
        {state.hasMore && (
          <Button tone="secondary" onClick={state.loadMore} disabled={state.loadingMore}>
            {t('Load more')}
          </Button>
        )}
      </>
    );
  }

  return (
    <div data-testid="if-money">
      <RecordListTemplate
        title={t('Balance entries title', { asset })}
        description={t('Balance entries intro', { asset })}
        state={READY}
        roomAction={
          <a
            className="lt-button lt-button-secondary"
            href="/money"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigate('/money');
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {t('Back to your money')}
          </a>
        }
        filters={
          <Segmented
            label={t('Entries account scope')}
            value={accountId ?? ALL}
            options={[
              { value: ALL, label: t('Entries all accounts') },
              { value: 'main', label: t('Entries main account') },
              ...spaces.map((space) => ({ value: space.id, label: space.name })),
            ]}
            onChange={(target) => navigate(balanceEntriesHref(asset, target === ALL ? undefined : target))}
          />
        }
        list={
          <div className="lt-stack">
            {body}
            {asset !== '' && <SetAside asset={asset} hidden={hideBalances} />}
          </div>
        }
      />
    </div>
  );
}
