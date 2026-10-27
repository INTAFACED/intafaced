import { ArrowLeft, Check } from 'lucide-react';
import { Amount, Button, fmtAmount, navigate, refusalCopy, Skeleton, StateBlock } from './deps';
import { moneyCopy } from './copy';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';
import { assetFromPath, balanceEntriesHref, accountFromSearch, signedOf, type BalanceEntryRow } from './balance-entries-model';
import { useBalanceEntries } from './balance-entries-source';
import { useNamedAccounts } from './portfolio-source';
import { SetAside } from './SetAside';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const accountLabel = (accountId: string, names: ReadonlyMap<string, string>, copy: Copy) =>
  accountId === 'main' ? copy.t('Entries main account') : (names.get(accountId) ?? copy.t('Entries other account'));

function Row({
  row,
  hidden,
  zone,
  names,
}: {
  row: BalanceEntryRow;
  hidden: boolean;
  zone: ReturnType<typeof usePreferences>['timeZone'];
  names: ReadonlyMap<string, string>;
}) {
  const copy = moneyCopy.useCopy();
  const signed = signedOf(row);
  const up = row.direction === 'debit';
  return (
    <tr>
      <td>
        <time dateTime={row.postedAt}>{stamp(row.postedAt, zone)}</time>
      </td>
      <td>{up ? copy.t('Money in direction') : copy.t('Money out direction')}</td>
      <td>{accountLabel(row.accountId, names, copy)}</td>
      <td className="money-num">
        <Amount
          value={signed === null ? '—' : `${up ? '+' : '−'}${fmtAmount(row.amount)}`}
          hidden={hidden}
          className={up ? 'text-up-text' : 'text-down-text'}
        />
      </td>
      <td>
        <code className="money-code">{row.txId}</code>
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

  const scope = (target: string | null, label: string) => (
    <a
      key={target ?? 'all'}
      className="money-alloc__opt"
      aria-current={accountId === target ? 'true' : undefined}
      href={balanceEntriesHref(asset, target ?? undefined)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(balanceEntriesHref(asset, target ?? undefined));
      }}
    >
      {label}
    </a>
  );

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
      <div aria-busy="true" role="status" aria-label={t('Loading entries')} className="money-detail__skeleton">
        <Skeleton width={260} height={28} className="bg-field" />
        <Skeleton width={200} height={20} className="bg-field" />
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
        <p className="money-detail__status" role="status">
          <span data-testid="money-act__done" className="money-act__done">
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
        <section data-testid="money-card" className="money-card money-detail__card" aria-label={t('Balance entries title', { asset })}>
          <table data-testid="money-table" className="money-table money-table--activity">
            <thead>
              <tr>
                <th scope="col">{t('Entries column when')}</th>
                <th scope="col">{t('Entries column what')}</th>
                <th scope="col">{t('Entries column account')}</th>
                <th scope="col" className="money-num">
                  {t('Entries column amount')}
                </th>
                <th scope="col">{t('Entries column reference')}</th>
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
                />
              ))}
            </tbody>
          </table>
        </section>
        {state.moreFailed && <p className="money-detail__note">{t('Couldn’t load more')}</p>}
        {state.hasMore && (
          <Button variant="secondary" size={40} onClick={state.loadMore} disabled={state.loadingMore}>
            {t('Load more')}
          </Button>
        )}
      </>
    );
  }

  return (
    <div data-testid="if-money" className="if-money if-money--activity money-detail">
      <a
        className="money-back"
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
      <header className="money-detail__head">
        <h1 className="money-title">{t('Balance entries title', { asset })}</h1>
        <p className="money-detail__note">{t('Balance entries intro', { asset })}</p>
      </header>
      <div className="money-alloc__switch" role="group" aria-label={t('Entries account scope')}>
        {scope(null, t('Entries all accounts'))}
        {scope('main', t('Entries main account'))}
        {spaces.map((space) => scope(space.id, space.name))}
      </div>
      {body}
      {asset !== '' && <SetAside asset={asset} hidden={hideBalances} />}
    </div>
  );
}
