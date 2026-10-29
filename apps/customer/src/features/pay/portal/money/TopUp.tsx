import { useId, useState } from 'react';
import { Button } from '@intafaced/ui';
import type { ApiResult } from '../../../../shared/api';
import { useResource, type Resource } from '../../../../shared/resource';
import { Field } from '../../ui-kit';
import { PaySection } from '../../components';
import { PortalFailure, PortalLoading } from '../components';
import type { PortalApi } from '../api';
import { TestBanner } from './common';
import { mc } from './copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** The service's own refusal for a business with no top-up rail (svc-pay merchant-pay-dev-out/top-up.ts). */
const isTopUpOff = (failure: Failed): boolean =>
  failure.code === 'pay.topup_unconfigured' || /^pay\.topup_unconfigured\b/.test(failure.message);

/**
 * `/pay/money/top-up` (M-money-out-02): ask to add money to the business balance. The form is always here; what a
 * top-up can use comes from the service, and with no top-up rail it refuses, so Request stays off and says why.
 * Nothing on this page moves money or shows a balance it did not read.
 */
export function TopUp({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const options = useResource((s) => portal.topUpOptions(merchantId, s), `money:top-up:${merchantId}`);
  return <TopUpView resource={options.resource} retry={options.reload} />;
}

/** The page itself, from the top-up read. */
export function TopUpView({ resource: r, retry }: { resource: Resource<never>; retry: () => void }) {
  const { t } = mc.useCopy();
  const [amount, setAmount] = useState('');
  const whyId = useId();
  // Until a top-up rail exists there is nothing a request could go to: the read always refuses (or has not answered),
  // so Request and the amount stay off. The rail's slice brings the answer shape and the request with it.
  const off = true;
  const why = r.status === 'failed' ? (isTopUpOff(r.failure) ? t('tuOffWhy') : null) : null;
  return (
    <div className="stack mn-page">
      <TestBanner />
      <PaySection title={t('tuFormTitle')} description={t('tuFormBody')}>
        {r.status === 'loading' ? (
          <PortalLoading rows={2} />
        ) : r.status === 'failed' ? (
          isTopUpOff(r.failure) ? (
            <div data-testid="failure" className="failure" role="status">
              <h3>{t('tuOffTitle')}</h3>
              <p>{t('tuOffBody')}</p>
            </div>
          ) : (
            <PortalFailure result={r.failure} retry={retry} />
          )
        ) : null}
        <form data-testid="form-stack" className="form-stack pp-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <Field
            label={t('tuAmount')}
            hint={t('tuAmountHint')}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={off}
          />
          <div className="pp-actions">
            <Button type="submit" variant="primary" disabled={off} aria-describedby={why ? whyId : undefined}>
              {t('tuRequest')}
            </Button>
          </div>
          {why && (
            <p id={whyId} className="muted pp-note" role="note">
              {why}
            </p>
          )}
        </form>
      </PaySection>
      <p className="muted pp-note">
        <a className="text-link" href="/pay/money">
          {t('tuBack')}
        </a>
      </p>
    </div>
  );
}
