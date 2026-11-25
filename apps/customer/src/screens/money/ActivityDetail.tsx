// volt-room: /money/activity/:id
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { Amount, Button, StateBlock } from '@intafaced/ui/lit';
import { KeyValue, RecordListTemplate, Skeleton, type KeyValueRow, type RoomState } from '@intafaced/ui/lit/templates';
import { coinHref, fmtAmount, navigate, refusalCopy, useActivity, type ActivityItem } from './deps';
import { moneyCopy } from './copy';
import { ActivityNote } from './ActivityNote';
import { stamp } from './time';
import { titleOf } from './activity-view';
import { DETAIL_MAX_PAGES, findGroup, idFromPath, sharedOrder } from './activity-detail';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../../features/session/session';
import { readSent, requestPath } from '../../features/pay/personal/personal-model';
import { withDeviceHandle } from '../../data';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

const READY: RoomState = { kind: 'ready' };
const AMOUNT_TONE = { in: 'lt-up', out: 'lt-down' } as const;

function CopyButton({ value, copy }: { value: string; copy: Copy }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      tone="secondary"
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

/**
 * A completed payment between two people has no Cancel: it is final. What it has is the way back, a refund, which is a
 * new payment: the sender asks the other person for it, the recipient sends it back from Pay with the figures filled in.
 */
function RefundPointer({ item, copy }: { item: ActivityItem; copy: Copy }) {
  if (item.kind !== 'transfer_in' && item.kind !== 'transfer_out') return null;
  const handle = item.counterparty?.handle ?? null;
  if (!handle)
    return (
      <p className="lt-hint" data-testid="money-refund">
        {copy.t('Refund unnamed note')}
      </p>
    );
  const sent = item.kind === 'transfer_out';
  // The sender's way back is a payment request they share with the other person; the recipient's is Send, filled in.
  const href = sent ? '/pay/request' : requestPath({ to: handle, amount: item.amount, asset: item.asset });
  return (
    <p className="lt-hint" data-testid="money-refund">
      {copy.t(sent ? 'Refund sent note' : 'Refund received note', { handle })}{' '}
      <a className="lt-link" href={href} data-testid="money-refund-link">
        {sent ? copy.t('Refund sent link') : copy.t('Refund received link', { handle })}
      </a>
    </p>
  );
}

const titleFor = (item: ActivityItem, copy: Copy) => titleOf(item, copy.t, (key, handle) => copy.t(key, { handle }));

/** One transaction in full: what it was, when, with whom, how much, and the reference support needs. */
export default function ActivityDetail({ rawId }: { rawId: string }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { hideBalances, layoutMode, timeZone } = usePreferences();
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
      className="lt-button lt-button-secondary"
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

  let pageTitle = t('Activity');
  let body: React.ReactNode;
  if (activity.status === 'loading') {
    body = (
      <div aria-busy="true" role="status" aria-label={t('Looking for this transaction')} className="lt-stack">
        <Skeleton shape="rows" count={3} />
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
      <div aria-busy="true" role="status" aria-label={t('Looking for this transaction')} className="lt-stack">
        <Skeleton shape="rows" count={3} />
        <p className="lt-hint">{t('Looking for this transaction')}</p>
      </div>
    );
  } else {
    // The bank does not always name the other person; a payment this device sent is named from the confirmation it kept.
    const item = withDeviceHandle(group.main, userId ? readSent(userId) : []);
    const up = item.direction === 'in';
    const cancelled = group.kind === 'cancelled';
    const holding = group.kind === 'open' || item.kind === 'order_hold';
    const title = cancelled ? t('Order cancelled · nothing spent') : titleFor(item, copy);
    pageTitle = title;
    const amount = fmtAmount(item.amount);
    // The asset page of a purchase: the asset its purchase line brought in. A sale or a refund has no such line.
    const bought = group.lines.find((line) => line.purchase === true)?.asset ?? null;
    const sharedOrderId = group.lines.length > 1 ? sharedOrder(group.lines) : null;
    const facts: KeyValueRow[] = [
      { label: t('Type'), value: title },
      { label: t('Direction'), value: up ? t('Money in direction') : t('Money out direction') },
      { label: t('Asset'), value: item.asset },
      ...(item.counterparty ? [{ label: t('Counterparty'), value: `@${item.counterparty.handle}` }] : []),
      ...(item.paymentNote ? [{ label: t('Payment note'), value: item.paymentNote }] : []),
      ...(item.spaceName ? [{ label: t('Account'), value: item.spaceName }] : []),
      { label: t('When'), value: <time dateTime={item.postedAt}>{stamp(item.postedAt, timeZone)}</time> },
      { label: t('Reference'), value: <code className="lt-mono">{item.txId}</code>, ltr: true },
      { label: t('Record number'), value: <code className="lt-mono">{item.id}</code>, ltr: true },
    ];
    body = (
      <div className="lt-stack">
        <div className="lt-stack lt-stack-tight">
          <Amount
            value={cancelled ? `${amount} ${item.asset}` : `${up ? '+' : '−'}${amount} ${item.asset}`}
            hidden={hideBalances}
            className={holding || cancelled ? undefined : AMOUNT_TONE[item.direction]}
          />
          <p className="lt-row lt-hint">
            {holding ? (
              <span data-testid="money-act__hold" className="lt-muted lt-nowrap">
                {t('Set aside')}
              </span>
            ) : (
              <span data-testid="money-act__done" className="lt-row lt-row-nowrap lt-nowrap">
                <Check size={14} aria-hidden="true" />
                {t('Completed')}
              </span>
            )}
            <span aria-hidden="true"> · </span>
            <time dateTime={item.postedAt}>{stamp(item.postedAt, timeZone)}</time>
          </p>
          {holding && <p className="lt-hint">{t('Set aside note')}</p>}
        </div>
        <section data-testid="money-card" className="lt-panel lt-stack" aria-label={t('Details')}>
          <h2>{t('Details')}</h2>
          <KeyValue rows={facts} label={t('Details')} />
          <p className="lt-hint">{t('Reference note')}</p>
          <div className="lt-actions">
            <CopyButton value={item.txId} copy={copy} />
            <a className="lt-button lt-button-secondary" href="/support">
              {t('Report a problem')}
            </a>
            {bought && (
              <a className="lt-button lt-button-secondary" href={coinHref(bought, 'simple')}>
                {t('See {asset} history', { asset: bought })}
              </a>
            )}
            {item.orderId && (
              <a className="lt-button lt-button-secondary" href="/money/activity?tab=orders">
                {t('See the order')}
              </a>
            )}
          </div>
          <p className="lt-hint">{t('Report a problem note')}</p>
          <RefundPointer item={item} copy={copy} />
          <ActivityNote key={item.id} item={item} />
        </section>
        {group.lines.length > 1 && (
          <section data-testid="money-card" className="lt-panel lt-stack" aria-label={t('Parts of this transaction')}>
            <h2>{t('Parts of this transaction')}</h2>
            {sharedOrderId && (
              <p className="lt-hint" data-label="shared-reference">
                {t('Parts share order')} <code className="lt-mono">{sharedOrderId}</code>
              </p>
            )}
            <div className="lt-table-scroll">
              <table data-testid="money-table" className="lt-table">
                <thead>
                  <tr>
                    <th scope="col">{t('Part')}</th>
                    <th scope="col">{t('Date')}</th>
                    <th scope="col" className="lt-end">
                      {t('Amount')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.lines.map((line) => (
                    <tr key={line.id}>
                      <td data-label={t('Part')}>{titleFor(line, copy)}</td>
                      <td data-testid="money-act__time" data-label={t('Date')} className="lt-nowrap">
                        <time dateTime={line.postedAt}>{stamp(line.postedAt, timeZone)}</time>
                      </td>
                      <td data-label={t('Amount')} className="lt-end">
                        <Amount
                          value={`${line.direction === 'in' ? '+' : '−'}${fmtAmount(line.amount)} ${line.asset}`}
                          hidden={hideBalances}
                          className={AMOUNT_TONE[line.direction]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    );
  }
  return (
    <div data-testid="if-money" data-density={layoutMode === 'pro' ? 'pro' : undefined}>
      <RecordListTemplate
        title={pageTitle}
        state={READY}
        mode={layoutMode === 'pro' ? 'pro' : 'simple'}
        roomAction={back}
        detailOnly
        list={null}
        detail={body}
      />
    </div>
  );
}
