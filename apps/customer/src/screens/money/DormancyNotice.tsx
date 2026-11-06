import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../../features/session/session';
import { defineCopy } from '../../shared/i18n';

/** Words for the dormancy fee notice on Activity (RC-bank-01, J-bank-16 #7). The fee and the days come from the bank. */
const dormancyCopy = defineCopy('dormancy-notice', {
  noticed:
    'Dormancy fee notice: {fee} {asset} will be taken on {date}, because this account has had no activity for {days} days. Use it or withdraw your balance before then to avoid the fee.',
  withdraw: 'Withdraw your balance',
  skippedZero: 'No dormancy fee was taken on {date}: the balance was 0.',
  skippedInsufficient: 'No dormancy fee was taken on {date}: the balance was below the {fee} {asset} fee, and a fee is never part-charged.',
  cancelled: 'The dormancy fee due on {date} was cancelled: this account was used after the notice.',
  charged: 'A dormancy fee of {fee} {asset} was taken on {date}.',
  unread: 'Dormancy fee notices could not be read from the bank just now.',
});

const noticesSchema = z.array(
  z.object({
    assetId: z.string(),
    fee: z.string(),
    debitDate: z.string(),
    inactiveDays: z.number().int(),
    state: z.enum(['noticed', 'cancelled', 'skipped_zero', 'skipped_insufficient', 'charged']),
    ledgerTxId: z.string().nullable(),
    noticedAt: z.string(),
    settledAt: z.string().nullable(),
  }),
);
type Notice = z.infer<typeof noticesSchema>[number];

/** The newest dormancy notice the bank gave this person, and how it was settled. Nothing shows with none. */
export function DormancyNotice() {
  const { api, userId } = useSession();
  const { t } = dormancyCopy.useCopy();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void api.query('bank', 'dormancy.notices', undefined, noticesSchema).then((result) => {
      if (!live) return;
      // No rule published is no notice to give; any other refusal is shown, never dropped.
      if (result.ok) setNotice(result.data[0] ?? null);
      else if (result.code !== 'bank.dormancy_rule_unset') setRefused(result.code ?? result.message);
    });
    return () => {
      live = false;
    };
  }, [api, userId]);
  if (refused)
    return (
      <p role="status" className="money-caption" data-testid="dormancy-notice" data-state="unread" data-code={refused}>
        {t('unread')}
      </p>
    );
  if (!notice) return null;
  const words = { fee: notice.fee, asset: notice.assetId, date: notice.debitDate, days: String(notice.inactiveDays) };
  return (
    <section
      data-testid="dormancy-notice"
      data-state={notice.state}
      data-fee={notice.fee}
      data-debit-date={notice.debitDate}
      role={notice.state === 'noticed' ? 'alert' : 'status'}
      className="money-card"
    >
      {notice.state === 'noticed' ? (
        <>
          <p>{t('noticed', words)}</p>
          <a className="text-link" href={`/uc/withdraw?asset=${encodeURIComponent(notice.assetId)}`}>
            {t('withdraw')}
          </a>
        </>
      ) : (
        <p>
          {t(
            notice.state === 'skipped_zero'
              ? 'skippedZero'
              : notice.state === 'skipped_insufficient'
                ? 'skippedInsufficient'
                : notice.state === 'cancelled'
                  ? 'cancelled'
                  : 'charged',
            words,
          )}
        </p>
      )}
    </section>
  );
}
