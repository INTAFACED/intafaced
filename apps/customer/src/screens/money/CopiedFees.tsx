import { Badge } from '@intafaced/ui';
import { fmtAmount } from './deps';
import { stamp } from './time';
import { copiedFeesCopy } from './copied-fees-copy';
import { useMyCopyFees, type CopiedFillFees } from './copied-fees-source';
import { usePreferences } from '../../shared/preferences';

type T = ReturnType<typeof copiedFeesCopy.useCopy>['t'];

/** A figure exactly as its source reports it: a builder fee of 0.000001 is never shown rounded away. */
const exact = (value: string) => fmtAmount(value, { places: 18 });

/**
 * The follower's copied venue fills on /money/activity (J-copy-bots-otc-06 #1): one row per fill, with the venue's fee and
 * our builder fee as the venue reports them, each named with its source, and the leader's share of our builder fee, which
 * INTAFACED pays and never adds to what the follower is charged. Shown only once the person has a copy on the venue.
 */
export function CopiedFees() {
  const { t } = copiedFeesCopy.useCopy();
  const { timeZone } = usePreferences();
  const read = useMyCopyFees();
  if (read.status === 'ready' && read.data.rows.length === 0) return null;
  if (read.status === 'empty' || read.status === 'refused') return null;
  return (
    <section aria-labelledby="money-copied-fees-title" data-testid="money-copied-fees" className="form-stack">
      <h2 id="money-copied-fees-title">
        {t('Title')}
        {read.status === 'ready' && read.data.venue?.test ? (
          <>
            {' '}
            <Badge tone="warn">{t('TEST')}</Badge>
          </>
        ) : null}
      </h2>
      <p className="money-caption">{t('Lede')}</p>
      {read.status === 'loading' ? <p className="money-caption">{t('Reading')}</p> : null}
      {read.status === 'error' ? <p className="money-caption">{t('Unread')}</p> : null}
      {read.status === 'ready' ? (
        <table aria-label={t('Title')} className="money-table money-table--activity">
          <thead>
            <tr>
              <th scope="col">{t('Trade')}</th>
              <th scope="col" className="money-num">
                {t('Venue fee')}
              </th>
              <th scope="col" className="money-num">
                {t('Our builder fee')}
              </th>
              <th scope="col">{t('Leader’s share of our builder fee')}</th>
            </tr>
          </thead>
          <tbody>
            {read.data.rows.map((row) => (
              <FillRow key={`${row.followId}:${row.fillId}`} row={row} venue={read.data.venue?.name ?? ''} t={t} zone={timeZone} />
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function shareWords(row: CopiedFillFees, t: T): { amount: string | null; state: string } {
  const lead = row.lead.displayName ?? t('a leader no longer listed');
  const s = row.feeShare;
  switch (s.state) {
    case 'none':
      return { amount: null, state: t('No builder fee on this fill, so nothing is shared') };
    case 'recording':
      return { amount: null, state: t('Recorded once our fee is booked') };
    case 'not_owed':
      return {
        amount: null,
        state:
          s.reason === 'cap_reached'
            ? t('Nothing owed: the leader’s cap per follower is reached')
            : t('Nothing owed: the share rounds to nothing'),
      };
    case 'waiting_collection':
      return {
        amount: t('{amount} {asset} to {lead}', { amount: exact(s.share.amount), asset: s.share.asset, lead }),
        state: t('Owed once the venue pays us this fee'),
      };
    case 'owed':
      return {
        amount: t('{amount} {asset} to {lead}', { amount: exact(s.share.amount), asset: s.share.asset, lead }),
        state: t('Owed by INTAFACED in our ledger'),
      };
  }
}

function FillRow({
  row,
  venue,
  t,
  zone,
}: {
  row: CopiedFillFees;
  venue: string;
  t: T;
  zone: ReturnType<typeof usePreferences>['timeZone'];
}) {
  const words = { amount: exact(row.amount), symbol: row.symbol, price: exact(row.price) };
  const share = shareWords(row, t);
  return (
    <tr data-testid="money-copied-fill" data-fill={row.fillId} data-share={row.feeShare.state} className="money-act">
      <td>
        <div className="money-act__text">
          <span className="money-act__title">
            {row.side === 'buy' ? t('Bought {amount} {symbol} at {price}', words) : t('Sold {amount} {symbol} at {price}', words)}
          </span>
          <span className="money-act__sub">{t('Copying {lead}', { lead: row.lead.displayName ?? t('a leader no longer listed') })}</span>
          <span data-testid="money-copied-fill__id" className="money-act__sub money-act__ref">
            {t('Fill {id}', { id: row.fillId })}
          </span>
          <span className="money-act__sub">
            <time dateTime={row.filledAt}>{stamp(row.filledAt, zone)}</time>
          </span>
        </div>
      </td>
      <td data-testid="money-copied-fill__venue-fee" className="money-num">
        <div className="money-act__text">
          <span>{t('{amount} {asset}', { amount: exact(row.venueFee.amount), asset: row.venueFee.asset })}</span>
          <span className="money-act__sub">{t('From {venue}, as it reports it', { venue })}</span>
        </div>
      </td>
      <td data-testid="money-copied-fill__builder-fee" className="money-num">
        <div className="money-act__text">
          <span>{t('{amount} {asset}', { amount: exact(row.builderFee.amount), asset: row.builderFee.asset })}</span>
          <span className="money-act__sub">{t('From INTAFACED, charged on the venue')}</span>
        </div>
      </td>
      <td data-testid="money-copied-fill__share">
        <div className="money-act__text">
          {share.amount ? <span>{share.amount}</span> : null}
          <span className="money-act__sub">{share.state}</span>
          {share.amount ? <span className="money-act__sub">{t('Paid by INTAFACED. Not charged to you.')}</span> : null}
        </div>
      </td>
    </tr>
  );
}
