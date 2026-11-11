import type { z } from 'zod';
import { displayAmount } from '../../shared/money';
import { ResourceView, useBankRead } from './components';
import type { cardSchema } from './contracts';
import { DepthPanel } from './DepthParts';
import { cardFeedCopy } from './card-feed-copy';

/**
 * A card's recurring payments and merchant refunds (J-bank-14 #6; BK-cpay-02). A recurring payment is one the card
 * issuer marked as a merchant charging the card on file, grouped by merchant (svc-bank `cards.recurring`). A refund is
 * the merchant giving a payment back; on a partner-held card the card partner moves it, and INTAFACED's ledger posts
 * nothing (`cards.authorizations` `refund`). Whether a refunded payment's cashback is taken back is an open owner
 * question, so this says so and changes nothing.
 */

type CardRecord = z.infer<typeof cardSchema>;

const dateOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function CardRecurringPanel({ card }: { card: CardRecord }) {
  const { t } = cardFeedCopy.useCopy();
  const read = useBankRead('cards.recurring', { cardId: card.id, limit: 50 });
  return (
    <DepthPanel title={t('recurringTitle')} lead={t('recurringLead')}>
      <ResourceView resource={read.resource} reload={read.reload}>
        {(rows) =>
          rows.length ? (
            <ul aria-label={t('recurringList')}>
              {rows.map((r) => {
                const where =
                  r.merchant === null
                    ? t('recurringNoMerchant')
                    : r.merchantCountry === null
                      ? r.merchant
                      : t('recurringMerchant', { merchant: r.merchant, country: r.merchantCountry });
                const facts = { amount: displayAmount(r.lastAmount), asset: card.assetId, date: dateOf(r.lastAt) };
                return (
                  <li key={`${r.merchant ?? ''}|${r.merchantCountry ?? ''}`} data-merchant={r.merchant ?? ''}>
                    <strong lang="und" dir="auto">
                      {where}
                    </strong>{' '}
                    {r.payments === 1 ? t('recurringOnePayment', facts) : t('recurringPayments', { ...facts, count: r.payments })}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">{t('recurringNone')}</p>
          )
        }
      </ResourceView>
    </DepthPanel>
  );
}

export function CardRefundsPanel({ card }: { card: CardRecord }) {
  const { t } = cardFeedCopy.useCopy();
  const read = useBankRead('cards.authorizations', { cardId: card.id, limit: 50 });
  return (
    <DepthPanel title={t('refundsTitle')} lead={t('refundsLead')}>
      <ResourceView resource={read.resource} reload={read.reload}>
        {(rows) => {
          const refunded = rows.flatMap((row) => (row.refund ? [{ row, refund: row.refund }] : []));
          if (!refunded.length) return <p className="muted">{t('refundsNone')}</p>;
          return (
            <>
              <ul aria-label={t('refundsList')}>
                {refunded.map(({ row, refund }) => {
                  const facts = {
                    amount: displayAmount(refund.amount),
                    asset: card.assetId,
                    ref: row.authorizationRef,
                    date: dateOf(refund.at),
                  };
                  return (
                    <li key={row.id} data-authorization={row.authorizationRef} data-refund={refund.status}>
                      {refund.status === 'settled'
                        ? t('refundSettled', facts)
                        : refund.status === 'pending'
                          ? t('refundPending', facts)
                          : t('refundRejected', facts)}
                    </li>
                  );
                })}
              </ul>
              <p className="money-caption">{t('refundCashback')}</p>
            </>
          );
        }}
      </ResourceView>
    </DepthPanel>
  );
}
