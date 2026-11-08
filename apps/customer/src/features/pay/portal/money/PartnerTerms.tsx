import type { ReactNode } from 'react';
import type { Resource } from '../../../../shared/resource';
import { MoneyText } from '../ui/MoneyText';
import { mc } from './copy';
import { bpsPercent } from './model';
import type { PartnerTerms } from './partner-terms-api';

/**
 * The acquiring partner's own terms, as lines a room shows (CUSTODY-DELTA §1.3 "Unknown, never zero"; OWNER 226). Each
 * reads the partner's answer, "not known" when the partner has not given one, or "not offered by the partner" when it
 * has said it does not offer it. A term that cannot be read says so; nothing here ever writes a zero for it.
 */
type Terms = Resource<PartnerTerms>;

function Line({ label, terms, children }: { label: string; terms: Terms; children: (t: PartnerTerms) => ReactNode }) {
  const { t } = mc.useCopy();
  return (
    <p data-testid="partner-term">
      <strong>{label}</strong>{' '}
      {terms.status === 'ready' ? children(terms.data) : terms.status === 'loading' ? t('partnerReading') : t('partnerUnread')}
    </p>
  );
}

/** M-money-out-01 (J-merchant-07 #1): the partner's reserve rule, or "not known". */
export function PartnerReserveLine({ terms }: { terms: Terms }) {
  const { t } = mc.useCopy();
  return (
    <Line label={t('partnerReserveLabel')} terms={terms}>
      {(p) =>
        p.reserveRule.known
          ? t('balReserveRule', { pct: bpsPercent(p.reserveRule.rollingReserveBps), days: p.reserveRule.holdDays })
          : t('partnerNotKnown')
      }
    </Line>
  );
}

/** M-disp-01 (J-merchant-18 #5): who covers what a lost dispute takes beyond your funds. Never the ledger. */
export function PartnerShortfallLine({ terms }: { terms: Terms }) {
  const { t } = mc.useCopy();
  return (
    <Line label={t('partnerShortfallLabel')} terms={terms}>
      {(p) =>
        !p.shortfallCover.known
          ? t('partnerNotKnown')
          : p.shortfallCover.who === 'merchant'
            ? t('partnerCoverMerchant')
            : p.shortfallCover.who === 'partner'
              ? t('partnerCoverPartner')
              : t('partnerCoverHouse')
      }
    </Line>
  );
}

/** M-adv-money-out-08 (J-merchant-10 #4): the partner's instant payout and its fee, "not known", or "not offered by the partner". */
export function PartnerInstantPayoutLine({ terms, test }: { terms: Terms; test: boolean }) {
  const { t } = mc.useCopy();
  return (
    <Line label={t('partnerInstantLabel')} terms={terms}>
      {(p) =>
        !p.instantPayout.known ? (
          t('partnerNotKnown')
        ) : !p.instantPayout.offered ? (
          t('partnerNotOffered')
        ) : p.instantPayout.fee.known ? (
          <>
            {t('partnerInstantFee')} <MoneyText value={p.instantPayout.fee.amount} asset={p.instantPayout.fee.assetCode} test={test} />
          </>
        ) : (
          `${t('partnerInstantFee')} ${t('partnerNotKnown')}`
        )
      }
    </Line>
  );
}

/**
 * M-adv-banking-cards-01 (J-merchant-10 #1): of the assets listed, each one the partner has said it does not offer reads
 * "not offered by the partner". Nothing is shown while the partner has not given its list: silence is not a refusal.
 */
export function PartnerCurrencyNotes({ terms, assets }: { terms: Terms; assets: readonly string[] }) {
  const { t } = mc.useCopy();
  if (terms.status !== 'ready' || !terms.data.currencies.known) return null;
  const offered = new Set(terms.data.currencies.offered);
  const missing = assets.filter((a) => !offered.has(a));
  if (missing.length === 0) return null;
  return (
    <ul className="muted" aria-label={t('partnerCurrenciesLabel')}>
      {missing.map((a) => (
        <li key={a} data-testid="partner-currency-not-offered">
          {a}: {t('partnerNotOffered')}
        </li>
      ))}
    </ul>
  );
}
