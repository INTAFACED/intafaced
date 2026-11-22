import { useId } from 'react';
import type { Resource } from '../../../../shared/resource';
import { DateTime } from '../ui/DateTime';
import { Loading, MoneyText } from '../volt/parts';
import { MoneyFailure } from './kit-parts';
import { mc } from './copy';
import { bpsPercent } from './model';
import type { MerchantReserveView as ReserveView } from '@intafaced/contracts/merchant-control';
import type { PartnerTerms } from './partner-terms-api';
import { PartnerReserveLine } from './PartnerTerms';

/**
 * M-money-out-01: the reserve card on Money. The reserve is recorded on each settlement but no ledger recipe books it,
 * so the card says "recorded, not withheld" and never takes the recorded amount out of a balance. An unreadable
 * reserve reads as a failure, never as zero.
 */
export function ReserveCard({
  resource,
  partner,
  retry,
  test,
}: {
  resource: Resource<ReserveView>;
  /** The acquiring partner's own reserve rule, or "not known" (J-merchant-07 #1). */
  partner?: Resource<PartnerTerms>;
  retry: () => void;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  const heading = useId();
  const r = resource;
  return (
    <section aria-labelledby={heading} data-testid="money-reserve">
      <h2 id={heading}>{t('balReserveTitle')}</h2>
      <p className="lt-hint">
        <strong>{t('balReserveLabel')}</strong> · {t('balReserveBody')}
      </p>
      {partner && <PartnerReserveLine terms={partner} />}
      {r.status === 'loading' ? (
        <Loading rows={2} />
      ) : r.status === 'failed' ? (
        <MoneyFailure result={r.failure} retry={retry} />
      ) : (
        <>
          <p>
            {r.data.rule
              ? t('balReserveRule', { pct: bpsPercent(r.data.rule.rollingReserveBps), days: r.data.rule.holdDays })
              : t('balReserveNoRule')}
          </p>
          {r.data.payoutsRefused && (
            <p className="lt-held" role="note">
              {t('balReservePayouts')}
            </p>
          )}
          {r.data.assets.length === 0 ? (
            <p className="lt-hint">{t('balReserveNone')}</p>
          ) : (
            <dl className="lt-kv">
              {r.data.assets.map((a) => (
                <div key={a.assetCode}>
                  <dt>
                    {t('balReserveRecorded')} · {a.assetCode}
                  </dt>
                  <dd>
                    <MoneyText value={a.recordedAmount} asset={a.assetCode} test={test} />
                    {a.nextReleaseAt && (
                      <span className="lt-hint">
                        {' · '}
                        {t('balReserveNext')} <DateTime value={a.nextReleaseAt} />
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
