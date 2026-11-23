import type { z } from 'zod';
import { BANK_CARDS_RECURRING } from '@intafaced/contracts/bank-cards-procedures';
import { BANK_CARDS_AUTHORIZATIONS } from '@intafaced/contracts/bank-cards-procedures';
import { displayAmount } from '../../../shared/money';
import { useBankRecord } from '../components';
import type { cardSchema } from '../contracts';
import { Panel, ResourceView } from '../bank-settings/parts';
import { cardFeedCopy } from '../card-feed-copy';

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
  const read = useBankRecord(BANK_CARDS_RECURRING, { cardId: card.id, limit: 50 });
  return (
    <Panel level={3} title={t('recurringTitle')} lead={t('recurringLead')}>
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
            <p className="lt-hint">{t('recurringNone')}</p>
          )
        }
      </ResourceView>
    </Panel>
  );
}

export function CardRefundsPanel({ card }: { card: CardRecord }) {
  const { t } = cardFeedCopy.useCopy();
  const read = useBankRecord(BANK_CARDS_AUTHORIZATIONS, { cardId: card.id, limit: 50 });
  return (
    <Panel level={3} title={t('refundsTitle')} lead={t('refundsLead')}>
      <ResourceView resource={read.resource} reload={read.reload}>
        {(rows) => {
          const refunded = rows.flatMap((row) => (row.refund ? [{ row, refund: row.refund }] : []));
          if (!refunded.length) return <p className="lt-hint">{t('refundsNone')}</p>;
          return (
            <>
              <ul aria-label={t('refundsList')}>
                {refunded.map(({ row, refund }) => {
                  const facts = {
                    amount: displayAmount(refund.amount),
                    // A pay-from payment (J-bank-29 #7): the partner credits the asset it held from, and the refund is in that asset.
                    asset: row.payFrom?.assetId ?? card.assetId,
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
              <p className="lt-hint">{t('refundCashback')}</p>
            </>
          );
        }}
      </ResourceView>
    </Panel>
  );
}
