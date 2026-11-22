import type { ReactNode } from 'react';
import type { Resource } from '../../../../shared/resource';
import { refusalText } from '../refusal';
import { mc } from '../money/copy';
import type { PartnerTerms } from '../money/partner-terms-api';
import { MoneyText } from './parts';

/**
 * The acquiring partner's instant payout line (`money/PartnerTerms.tsx`'s `PartnerInstantPayoutLine`), drawn from the
 * kit, with the same id and words: the partner's answer, "not known" when it has not given one, or "not offered by the
 * partner" when it has said it does not offer it. A term that cannot be read says so; nothing here ever writes a zero.
 */
type Terms = Resource<PartnerTerms>;

function Line({ label, terms, children }: { label: string; terms: Terms; children: (t: PartnerTerms) => ReactNode }) {
  const { t } = mc.useCopy();
  return (
    <p data-testid="partner-term">
      <strong>{label}</strong>{' '}
      {terms.status === 'ready'
        ? children(terms.data)
        : terms.status === 'loading'
          ? t('partnerReading')
          : // The refusal in words (no partner here: `pay.partner_terms_unavailable`), never "not known" for a failed read.
            refusalText(terms.failure)}
    </p>
  );
}

/** M-adv-money-out-08 (J-merchant-10 #4): the partner’s instant payout and its fee, "not known", or "not offered by the partner". */
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
