import { useId } from 'react';
import type { Resource } from '../../../../shared/resource';
import { PortalLoading } from '../components';
import { DateTime } from '../ui/DateTime';
import { MoneyText } from '../ui/MoneyText';
import { MoneyFailure } from './common';
import { mc } from './copy';
import { bpsPercent } from './model';
import type { ReserveView } from './schemas';

/**
 * M-money-out-01: the reserve card on Money. The reserve is recorded on each settlement but no ledger recipe books it,
 * so the card says "recorded, not withheld" and never takes the recorded amount out of a balance. An unreadable
 * reserve reads as a failure, never as zero.
 */
export function ReserveCard({ resource, retry, test }: { resource: Resource<ReserveView>; retry: () => void; test: boolean }) {
  const { t } = mc.useCopy();
  const heading = useId();
  const r = resource;
  return (
    <section className="pay-section" aria-labelledby={heading} data-testid="money-reserve">
      <header>
        <div>
          <h2 id={heading}>{t('balReserveTitle')}</h2>
          <p className="muted">
            <strong>{t('balReserveLabel')}</strong> · {t('balReserveBody')}
          </p>
        </div>
      </header>
      {r.status === 'loading' ? (
        <PortalLoading rows={2} />
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
            <p className="pp-callout" role="note">
              {t('balReservePayouts')}
            </p>
          )}
          {r.data.assets.length === 0 ? (
            <p className="muted">{t('balReserveNone')}</p>
          ) : (
            <dl className="pp-facts">
              {r.data.assets.map((a) => (
                <div key={a.assetCode}>
                  <dt>
                    {t('balReserveRecorded')} · {a.assetCode}
                  </dt>
                  <dd>
                    <MoneyText value={a.recordedAmount} asset={a.assetCode} test={test} />
                    {a.nextReleaseAt && (
                      <span className="muted">
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
