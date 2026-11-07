import { useState } from 'react';
import { defineCopy } from '../../shared/i18n';
import { useBankRead } from './components';
import { DepthPanel } from './DepthParts';
import { useHoldings } from './holdings';
import './bank-depth.css';

/** Words for the limits, fees and plan room (BK-acct-04, J-bank-16 #6). No limit, fee or price is written here. */
export const limitsCopy = defineCopy('bank-limits', {
  title: 'Limits, fees and plan',
  description: 'What you can send today, the fees the bank has published and your plan.',
  limitsTitle: 'Sending limits',
  limitsLead: 'What the bank lets you send to people today, from its own quote. Limits refresh at 00:00 UTC.',
  asset: 'Coin',
  daily: 'Daily send limit: {amount} {asset}',
  used: 'Sent today: {amount} {asset}',
  remaining: 'Left to send today: {amount} {asset}',
  perTransfer: 'Largest single send: {amount} {asset}',
  remainingUnread: 'Left to send today: not read from the bank.',
  feesTitle: 'Fees',
  sendFee: 'Sending to a person in {asset}: {fee}',
  free: 'free',
  feeAmount: '{amount} {asset}',
  sendFeesNone: 'Sending to a person: no fee schedule is published.',
  accountFeesNotSet: 'Account fees: not set. The bank has published no account fee table, so none is charged.',
  accountFeeLine: '{label}: {amount} {asset}',
  planTitle: 'Your plan',
  planCurrent: 'Your plan: {name} · tier {tier} · {price} {asset} a month',
  plansTable: 'Plans',
  planName: 'Plan',
  planTier: 'Tier',
  planBilling: 'Billing',
  planBillingValue: '{price} {asset} a month',
  planBlocked: 'Paid plans need a plan fee the bank cannot post yet ({code}), so none can be chosen.',
  failed: '{message}',
});

/** `/bank/limits`: today's send limit and what is left of it, the fee schedules, and the person's plan. */
export function LimitsRoom() {
  const { t } = limitsCopy.useCopy();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const [chosen, setChosen] = useState('');
  const assetId = chosen || assets[0]?.assetId || '';
  const quote = useBankRead('transfers.quote', { assetId, amount: '0' }, Boolean(assetId));
  const sendFees = useBankRead('fees.schedule.get', undefined);
  const accountFees = useBankRead('fees.account', undefined);
  const plans = useBankRead('plans.list', undefined);
  const refusal = (failure: { code?: string | null; message: string }) => (
    <p role="alert" className="error-text" data-code={failure.code ?? ''}>
      {t('failed', { message: failure.message })}
    </p>
  );

  return (
    <div className="bd-stack" data-testid="bank-limits">
      <DepthPanel title={t('limitsTitle')} lead={t('limitsLead')}>
        <label className="field">
          <span>{t('asset')}</span>
          <select value={assetId} onChange={(event) => setChosen(event.target.value)} disabled={assets.length === 0}>
            {assets.map((asset) => (
              <option key={asset.assetId} value={asset.assetId}>
                {asset.assetId}
              </option>
            ))}
          </select>
        </label>
        {quote.resource.status === 'failed' && refusal(quote.resource.failure)}
        {quote.resource.status === 'ready' && (
          <ul
            data-testid="bank-limits-today"
            data-daily={quote.resource.data.dailyLimit}
            data-used={quote.resource.data.spentToday}
            data-remaining={quote.resource.data.remainingToday ?? ''}
          >
            <li>{t('daily', { amount: quote.resource.data.dailyLimit, asset: assetId })}</li>
            <li>{t('used', { amount: quote.resource.data.spentToday, asset: assetId })}</li>
            <li>
              {quote.resource.data.remainingToday !== undefined
                ? t('remaining', { amount: quote.resource.data.remainingToday, asset: assetId })
                : t('remainingUnread')}
            </li>
            <li>{t('perTransfer', { amount: quote.resource.data.perTransferLimit, asset: assetId })}</li>
          </ul>
        )}
      </DepthPanel>
      <DepthPanel title={t('feesTitle')}>
        {sendFees.resource.status === 'failed' && refusal(sendFees.resource.failure)}
        {sendFees.resource.status === 'ready' && (
          <ul data-testid="bank-send-fees" data-published={String(sendFees.resource.data.published)}>
            {sendFees.resource.data.published ? (
              sendFees.resource.data.entries.map((e) => (
                <li key={e.assetId} data-asset={e.assetId}>
                  {t('sendFee', { asset: e.assetId, fee: e.free ? t('free') : t('feeAmount', { amount: e.fee, asset: e.assetId }) })}
                </li>
              ))
            ) : (
              <li>{t('sendFeesNone')}</li>
            )}
          </ul>
        )}
        {accountFees.resource.status === 'failed' && refusal(accountFees.resource.failure)}
        {accountFees.resource.status === 'ready' &&
          (accountFees.resource.data.set ? (
            <ul data-testid="bank-account-fees" data-state="set">
              {accountFees.resource.data.lines.map((l) => (
                <li key={l.id}>{t('accountFeeLine', { label: l.label, amount: l.fee, asset: l.assetId })}</li>
              ))}
            </ul>
          ) : (
            <p className="money-caption" data-testid="bank-account-fees" data-state="not-set">
              {t('accountFeesNotSet')}
            </p>
          ))}
      </DepthPanel>
      <DepthPanel title={t('planTitle')}>
        {plans.resource.status === 'failed' && refusal(plans.resource.failure)}
        {plans.resource.status === 'ready' && (
          <>
            <p data-testid="bank-plan-current" data-plan={plans.resource.data.current.id}>
              {t('planCurrent', {
                name: plans.resource.data.current.name,
                tier: plans.resource.data.current.tier,
                price: plans.resource.data.current.price,
                asset: plans.resource.data.current.assetId,
              })}
            </p>
            <table aria-label={t('plansTable')}>
              <thead>
                <tr>
                  <th scope="col">{t('planName')}</th>
                  <th scope="col">{t('planTier')}</th>
                  <th scope="col">{t('planBilling')}</th>
                </tr>
              </thead>
              <tbody>
                {plans.resource.data.plans.map((p) => (
                  <tr key={p.id} data-plan={p.id} data-blocker={p.blocker ?? ''}>
                    <th scope="row">{p.name}</th>
                    <td>{p.tier}</td>
                    <td>{t('planBillingValue', { price: p.price, asset: p.assetId })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plans.resource.data.plans.some((p) => p.blocker) && (
              <p className="money-caption" data-code="bank.plan_fee_unwired">
                {t('planBlocked', { code: 'bank.plan_fee_unwired' })}
              </p>
            )}
          </>
        )}
      </DepthPanel>
    </div>
  );
}
