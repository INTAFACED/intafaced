import { useId, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useResource, type Resource } from '../../../../shared/resource';
import { codeOf } from '../refusal';
import type { PortalApi } from '../api';
import { mc } from '../money/copy';
import { TOP_UP_OFF } from '../money/refusals';
import { Actions, Failure, Loading, Section, TestBanner } from './parts';

/**
 * `/pay/money/top-up` (M-money-out-02), on the flow template: ask to add money to the business balance. The form is
 * always here; what a top-up can use comes from the service, and with no top-up rail it refuses
 * (`pay.topup_unconfigured`, worded as a not-live card through `money/refusals.ts`), so Request stays off and the note
 * says why. Nothing on this page moves money or shows a balance it did not read.
 */
export function TopUp({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const options = useResource((s) => portal.topUpOptions(merchantId, s), `money:top-up:${merchantId}`);
  return <TopUpView resource={options.resource} retry={options.reload} />;
}

/**
 * The page itself, from the top-up read. Request and Amount follow the service: off while the read is loading or
 * refused (with the blocker named in the note), on only once it answers what a top-up can use. Today the read always
 * refuses (svc-pay declares no answer shape, `z.never()`), so on is reachable only when a rail's slice brings one.
 */
export function TopUpView({ resource: r, retry }: { resource: Resource<unknown>; retry: () => void }) {
  const { t } = mc.useCopy();
  const whyId = useId();
  const [amount, setAmount] = useState('');
  const off = r.status !== 'ready';
  const why = r.status === 'ready' ? null : r.status === 'failed' && codeOf(r.failure) === TOP_UP_OFF ? t('tuOffWhy') : t('tuOffPending');
  return (
    <FlowTemplate
      framed
      title={t('pageTopUp')}
      state={{ kind: 'ready' }}
      step={
        <>
          <TestBanner />
          <Section title={t('tuFormTitle')} description={t('tuFormBody')}>
            {r.status === 'loading' ? <Loading rows={2} /> : r.status === 'failed' ? <Failure result={r.failure} retry={retry} /> : null}
            <form data-testid="form-stack" noValidate onSubmit={(e) => e.preventDefault()}>
              <Field
                label={t('tuAmount')}
                hint={t('tuAmountHint')}
                inputMode="decimal"
                autoComplete="off"
                value={off ? '' : amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={off}
              />
              <Actions>
                <Button type="submit" tone="primary" disabled={off} aria-describedby={why ? whyId : undefined}>
                  {t('tuRequest')}
                </Button>
              </Actions>
              {why && (
                <p id={whyId} className="lt-hint" role="note">
                  {why}
                </p>
              )}
            </form>
          </Section>
        </>
      }
    />
  );
}
