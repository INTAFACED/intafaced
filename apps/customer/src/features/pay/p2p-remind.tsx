import { useEffect, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { PayFailure } from './components';
import { Button } from '@intafaced/ui';
import { formatDateTime } from './portal/ui/format';
import type { PersonalPayApi } from './pay-api';
import { remindCopy } from './p2p-remind-copy';
import type { Trade, TradeReminders } from './schemas';

/**
 * P-trade-orders-15 / J-p2p-02 #2: on a paid order the buyer may remind the seller to check the payment and release,
 * after the service's wait and up to its count. The button says when it opens, or why it never will; svc-p2p decides.
 */
export function RemindSeller({ trade, pay, onSent }: { trade: Trade; pay: PersonalPayApi; onSent: () => void }) {
  const { t, requestedLocale } = remindCopy.useCopy();
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [sending, setSending] = useState(false);
  // What svc-p2p answered to this page's own reminder, until the order is read again.
  const [answered, setAnswered] = useState<TradeReminders | null>(null);
  useEffect(() => setAnswered(null), [trade.reminders]);
  const [now, setNow] = useState(() => Date.now());
  const reminders = answered ?? trade.reminders ?? null;
  const nextAt = reminders?.nextAt ? Date.parse(reminders.nextAt) : null;
  // Re-render once the wait ends, so the button opens without a reload (capped: a timer cannot wait past ~24 days).
  useEffect(() => {
    if (nextAt === null || nextAt <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(nextAt - now + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [nextAt, now]);
  const time = (iso: string) => formatDateTime(iso, requestedLocale)?.short ?? iso;
  const open = reminders !== null && nextAt !== null && nextAt <= now;
  const note =
    reminders === null
      ? t('remindUnread')
      : reminders.max === null
        ? t('remindUnset')
        : nextAt === null
          ? t('remindSpent', { max: String(reminders.max) })
          : open
            ? t('remindWhy')
            : t('remindFrom', { time: time(reminders.nextAt!) });
  // svc-p2p's refusals in this room's words, with the time or count it sent.
  const refusal = failure ? refusalText(t, failure, time) : null;
  return (
    <div className="stack" data-testid="order-remind">
      <Button
        variant="secondary"
        disabled={!open || sending}
        onClick={async () => {
          setSending(true);
          setFailure(null);
          const result = await pay.remindSeller(trade.id);
          setSending(false);
          if (!result.ok) {
            setFailure(result);
            return;
          }
          setAnswered(result.data);
          onSent();
        }}
      >
        {t('remind')}
      </Button>
      <p className="muted">{note}</p>
      {reminders?.lastAt ? <p className="muted">{t('sentToSeller', { time: time(reminders.lastAt) })}</p> : null}
      {refusal ? (
        <p data-testid="failure" className="failure" role="status">
          {refusal}
        </p>
      ) : failure ? (
        <PayFailure result={failure} />
      ) : null}
    </div>
  );
}

function refusalText(
  t: ReturnType<typeof remindCopy.useCopy>['t'],
  failure: Extract<ApiResult<unknown>, { ok: false }>,
  time: (iso: string) => string,
): string | null {
  const limit = failure.p2pLimit;
  if (failure.code === 'p2p.remind_too_early') return limit?.until ? t('remindFrom', { time: time(limit.until) }) : t('remindEarly');
  if (failure.code === 'p2p.remind_rate_limited') return limit?.cap ? t('remindSpent', { max: limit.cap }) : t('remindSpentPlain');
  if (failure.code === 'p2p.config_unset') return t('remindUnset');
  return null;
}

/** The seller's side: the buyer's last reminder on a paid order, with what to do. */
export function SellerReminder({ reminders }: { reminders: TradeReminders | null | undefined }) {
  const { t, requestedLocale } = remindCopy.useCopy();
  if (!reminders?.lastAt) return null;
  return (
    <p className="muted" role="status" data-testid="order-reminder">
      {t('sellerReminded', { time: formatDateTime(reminders.lastAt, requestedLocale)?.short ?? reminders.lastAt })}
    </p>
  );
}
