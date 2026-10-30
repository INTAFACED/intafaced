import { useId } from 'react';
import { Button } from '@intafaced/ui';
import { useResource, type Resource } from '../../../../shared/resource';
import { Field } from '../../ui-kit';
import { PaySection } from '../../components';
import { PortalFailure, PortalLoading } from '../components';
import { codeOf } from '../refusal';
import type { PortalApi } from '../api';
import { TestBanner } from './common';
import { mc } from './copy';
import { TOP_UP_OFF } from './refusals';

/**
 * `/pay/money/top-up` (M-money-out-02): ask to add money to the business balance. The form is always here; what a
 * top-up can use comes from the service, and with no top-up rail it refuses (`pay.topup_unconfigured`, worded as a
 * not-live card through `money/refusals.ts`), so Request stays off and the note says why. Nothing on this page moves
 * money or shows a balance it did not read.
 */
export function TopUp({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const options = useResource((s) => portal.topUpOptions(merchantId, s), `money:top-up:${merchantId}`);
  return <TopUpView resource={options.resource} retry={options.reload} />;
}

/** The page itself, from the top-up read. */
export function TopUpView({ resource: r, retry }: { resource: Resource<never>; retry: () => void }) {
  const { t } = mc.useCopy();
  const whyId = useId();
  // Until a top-up rail exists there is nothing a request could go to: the read always refuses (or has not answered),
  // so Request and the amount are always off, and the note always names the blocker. The rail's slice brings the
  // answer shape, the amount's precision and the request with it.
  const why = r.status === 'failed' && codeOf(r.failure) === TOP_UP_OFF ? t('tuOffWhy') : t('tuOffPending');
  return (
    <div className="stack mn-page">
      <TestBanner />
      <PaySection title={t('tuFormTitle')} description={t('tuFormBody')}>
        {r.status === 'loading' ? (
          <PortalLoading rows={2} />
        ) : r.status === 'failed' ? (
          <PortalFailure result={r.failure} retry={retry} />
        ) : null}
        <form data-testid="form-stack" className="form-stack pp-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <Field label={t('tuAmount')} hint={t('tuAmountHint')} inputMode="decimal" autoComplete="off" value="" readOnly disabled />
          <div className="pp-actions">
            <Button type="submit" variant="primary" disabled aria-describedby={whyId}>
              {t('tuRequest')}
            </Button>
          </div>
          <p id={whyId} className="muted pp-note" role="note">
            {why}
          </p>
        </form>
      </PaySection>
    </div>
  );
}
