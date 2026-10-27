import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { Amount, Button, coinHref, fmtAmount, navigate, refusalCopy, Skeleton, StateBlock, useActivity, type ActivityItem } from './deps';
import { moneyCopy } from './copy';
import { ActivityNote } from './ActivityNote';
import { stamp } from './time';
import { titleOf } from './activity-view';
import { DETAIL_MAX_PAGES, findGroup, idFromPath, sharedOrder } from './activity-detail';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../../features/session/session';
import { readSent } from '../../features/pay/personal/personal-model';
import { withDeviceHandle } from '../../data';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="money-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyButton({ value, copy }: { value: string; copy: Copy }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      size={40}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 2000);
          },
          () => undefined,
        );
      }}
    >
      {done ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      {done ? copy.t('Copied') : copy.t('Copy reference')}
    </Button>
  );
}

const titleFor = (item: ActivityItem, copy: Copy) => titleOf(item, copy.t, (key, handle) => copy.t(key, { handle }));

/** One transaction in full: what it was, when, with whom, how much, and the reference support needs. */
export default function ActivityDetail({ rawId }: { rawId: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, timeZone } = usePreferences();
  const { userId } = useSession();
  const id = idFromPath(rawId);
  const activity = useActivity({ pageSize: 100 });
  const pages = useRef(0);
  const feed = activity.status === 'ready' ? activity.data : null;
  const group = feed ? findGroup(feed.items, id) : null;

  // The service has no "get one" call, so look back through the history until it turns up, within a bound.
  useEffect(() => {
    if (!feed || group || !feed.hasMore || feed.loadingMore || feed.moreFailed || pages.current >= DETAIL_MAX_PAGES) return;
    pages.current += 1;
    feed.loadMore();
  }, [feed, group]);

  const back = (
    <a
      className="money-back"
      href="/money/activity"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
        else navigate('/money/activity');
      }}
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t('Back to activity')}
    </a>
  );

  let body: React.ReactNode;
  if (activity.status === 'loading') {
    body = (
      <div aria-busy="true" role="status" aria-label={t('Looking for this transaction')} className="money-detail__skeleton">
        <Skeleton width={220} height={36} className="bg-field" />
        <Skeleton width={160} height={20} className="bg-field" />
      </div>
    );
  } else if (activity.status === 'error') {
    body = <StateBlock kind="error" title={t('Couldn’t load this transaction')} onRetry={activity.retry} retryLabel={t('Try again')} />;
  } else if (activity.status === 'refused') {
    const words = refusalCopy(activity.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  } else if (activity.status === 'empty' || (feed && !group && !feed.hasMore) || (feed && !group && pages.current >= DETAIL_MAX_PAGES)) {
    body = (
      <StateBlock
        kind="empty"
        title={t('Transaction not found')}
        body={t('Transaction not found body')}
        action={{ label: t('Back to activity'), href: '/money/activity' }}
      />
    );
  } else if (!group) {
    body = (
      <div aria-busy="true" role="status" aria-label={t('Looking for this transaction')} className="money-detail__skeleton">
        <Skeleton width={220} height={36} className="bg-field" />
        <p className="money-detail__note">{t('Looking for this transaction')}</p>
      </div>
    );
  } else {
    // The bank does not always name the other person; a payment this device sent is named from the confirmation it kept.
    const item = withDeviceHandle(group.main, userId ? readSent(userId) : []);
    const up = item.direction === 'in';
    const cancelled = group.kind === 'cancelled';
    const holding = group.kind === 'open' || item.kind === 'order_hold';
    const title = cancelled ? t('Order cancelled · nothing spent') : titleFor(item, copy);
    const amount = fmtAmount(item.amount);
    // The asset page of a purchase: the asset its purchase line brought in. A sale or a refund has no such line.
    const bought = group.lines.find((line) => line.purchase === true)?.asset ?? null;
    const sharedOrderId = group.lines.length > 1 ? sharedOrder(group.lines) : null;
    body = (
      <>
        <header className="money-detail__head">
          <h1 className="money-title">{title}</h1>
          <Amount
            value={cancelled ? `${amount} ${item.asset}` : `${up ? '+' : '−'}${amount} ${item.asset}`}
            hidden={hideBalances}
            className={`money-detail__amount ${holding || cancelled ? '' : up ? 'text-up-text' : 'text-down-text'}`}
          />
          <p className="money-detail__status">
            {holding ? (
              <span data-testid="money-act__hold" className="money-act__hold">
                {t('Set aside')}
              </span>
            ) : (
              <span data-testid="money-act__done" className="money-act__done">
                <Check size={14} aria-hidden="true" />
                {t('Completed')}
              </span>
            )}
            <span aria-hidden="true"> · </span>
            <time dateTime={item.postedAt}>{stamp(item.postedAt, timeZone)}</time>
          </p>
          {holding && <p className="money-detail__note">{t('Set aside note')}</p>}
        </header>
        <section data-testid="money-card" className="money-card money-detail__card" aria-label={t('Details')}>
          <h2 className="money-detail__h">{t('Details')}</h2>
          <dl className="money-facts">
            <Fact label={t('Type')}>{title}</Fact>
            <Fact label={t('Direction')}>{up ? t('Money in direction') : t('Money out direction')}</Fact>
            <Fact label={t('Asset')}>{item.asset}</Fact>
            {item.counterparty && <Fact label={t('Counterparty')}>@{item.counterparty.handle}</Fact>}
            {item.paymentNote && <Fact label={t('Payment note')}>{item.paymentNote}</Fact>}
            {item.spaceName && <Fact label={t('Account')}>{item.spaceName}</Fact>}
            <Fact label={t('When')}>
              <time dateTime={item.postedAt}>{stamp(item.postedAt, timeZone)}</time>
            </Fact>
            <Fact label={t('Reference')}>
              <code className="money-code">{item.txId}</code>
            </Fact>
            <Fact label={t('Record number')}>
              <code className="money-code">{item.id}</code>
            </Fact>
          </dl>
          <p className="money-detail__note">{t('Reference note')}</p>
          <div className="money-detail__actions">
            <CopyButton value={item.txId} copy={copy} />
            <Button variant="secondary" size={40} nativeButton={false} render={<a href="/support" />}>
              {t('Report a problem')}
            </Button>
            {bought && (
              <Button variant="secondary" size={40} nativeButton={false} render={<a href={coinHref(bought, 'simple')} />}>
                {t('See {asset} history', { asset: bought })}
              </Button>
            )}
            {item.orderId && (
              <Button variant="secondary" size={40} nativeButton={false} render={<a href="/money/activity?tab=orders" />}>
                {t('See the order')}
              </Button>
            )}
          </div>
          <p className="money-detail__note">{t('Report a problem note')}</p>
          <ActivityNote key={item.id} item={item} />
        </section>
        {group.lines.length > 1 && (
          <section data-testid="money-card" className="money-card money-detail__card" aria-label={t('Parts of this transaction')}>
            <h2 className="money-detail__h">{t('Parts of this transaction')}</h2>
            {sharedOrderId && (
              <p className="money-detail__note" data-label="shared-reference">
                {t('Parts share order')} <code className="money-code">{sharedOrderId}</code>
              </p>
            )}
            <table data-testid="money-table" className="money-table money-table--activity">
              <thead>
                <tr>
                  <th scope="col">{t('Part')}</th>
                  <th scope="col">{t('Date')}</th>
                  <th scope="col" className="money-num">
                    {t('Amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{titleFor(line, copy)}</td>
                    <td data-testid="money-act__time" className="money-act__time">
                      <time dateTime={line.postedAt}>{stamp(line.postedAt, timeZone)}</time>
                    </td>
                    <td className="money-num">
                      <Amount
                        value={`${line.direction === 'in' ? '+' : '−'}${fmtAmount(line.amount)} ${line.asset}`}
                        hidden={hideBalances}
                        className={line.direction === 'in' ? 'text-up-text' : 'text-down-text'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </>
    );
  }
  return (
    <div data-testid="if-money" className="if-money if-money--activity money-detail">
      {back}
      {body}
    </div>
  );
}
