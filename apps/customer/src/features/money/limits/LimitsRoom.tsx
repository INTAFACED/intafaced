// volt-room: /bank/limits
import { isVerifyFirst } from '../../../shared/api';
import { VerifyFirstNote } from '../../../shared/verify-first';
import { BANK_TRANSFERS_QUOTE } from '@intafaced/contracts/bank-transfers-procedures';
import { BANK_FEES_PARTNER } from '@intafaced/contracts/bank-fees-procedures';
import { BANK_PLANS_LIST } from '@intafaced/contracts/bank-plans-procedures';
import { BANK_FEES_SCHEDULE_GET } from '@intafaced/contracts/bank-fees-procedures';
import { BANK_FEES_ACCOUNT } from '@intafaced/contracts/bank-fees-procedures';
import { useState } from 'react';
import { Select } from '@intafaced/ui/lit';
import { defineCopy } from '../../../shared/i18n';
import { useBankRecord } from '../components';
import { useHoldings } from '../holdings';
import { BankSettingsRoom } from '../bank-settings/BankSettingsRoom';
import { Panel } from '../bank-settings/parts';

/** Words for the limits, fees and plan room (BK-acct-04, J-bank-16 #6). No limit, fee or price is written here. */
const limitsCopy = defineCopy('bank-limits', {
  title: 'Limits, fees and plan',
  description: 'What you can send today, the fees the bank has published and your plan.',
  sectionsLabel: 'Limits sections',
  explain:
    'Every limit and fee here is read from the bank as it stands now; none is written in the app. A limit or fee the bank has not published says not set, and nothing is charged for it.',
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
  planBlocked: 'Paid plans need a plan fee the bank cannot take yet, so none can be chosen.',
  partnerLead: 'What {partner} lets you send today and what it charges. These are its figures, not ours.',
  partnerDaily: 'Daily send limit at {partner}: {amount} {asset}',
  partnerUsed: 'Sent today: {amount} {asset}',
  partnerRemaining: 'Left to send today: {amount} {asset}',
  partnerNotSet: 'Daily send limit at {partner}: not set',
  partnerFee: 'Sending to a person, charged by {partner}: {amount} {asset}',
  partnerFeeNotSet: 'Sending to a person, charged by {partner}: not set',
  planLead: 'This plan fee is our own, separate from anything the bank partner charges.',
  failed: '{message}',
});

/** The room's sections, each a link to its part of the page. */
const SECTIONS = [
  ['limits-sending', 'limitsTitle'],
  ['limits-fees', 'feesTitle'],
  ['limits-plan', 'planTitle'],
] as const;

/** `/bank/limits` (BK-acct-04, J-bank-16 #6), inside the Overview room, on its settings template. */
export function LimitsPage() {
  const { t } = limitsCopy.useCopy();
  return (
    <BankSettingsRoom
      room="Overview"
      title={t('title')}
      description={t('description')}
      state={{ kind: 'ready' }}
      sectionsLabel={t('sectionsLabel')}
      sections={SECTIONS.map(([id, key]) => [id, t(key)] as const)}
      explain={t('explain')}
    >
      <LimitsRoom />
    </BankSettingsRoom>
  );
}

/** `/bank/limits`: today's send limit and what is left of it, the fee schedules, and the person's plan. */
function LimitsRoom() {
  const { t } = limitsCopy.useCopy();
  const held = useHoldings();
  const assets = held.resource.status === 'ready' ? held.resource.data.assets : [];
  const [chosen, setChosen] = useState('');
  const assetId = chosen || assets[0]?.assetId || '';
  const quote = useBankRecord(BANK_TRANSFERS_QUOTE, { assetId, amount: '0' }, Boolean(assetId));
  const partner = useBankRecord(BANK_FEES_PARTNER, { assetId }, Boolean(assetId));
  const heldAtPartner = partner.resource.status === 'ready' && partner.resource.data.held ? partner.resource.data : null;
  const sendFees = useBankRecord(BANK_FEES_SCHEDULE_GET, undefined);
  const accountFees = useBankRecord(BANK_FEES_ACCOUNT, undefined);
  const plans = useBankRecord(BANK_PLANS_LIST, undefined);
  const refusal = (failure: { code?: string | null; message: string }) =>
    isVerifyFirst(failure) ? (
      <VerifyFirstNote code={failure.code ?? undefined} />
    ) : (
      <p role="alert" data-code={failure.code ?? ''}>
        {t('failed', { message: failure.message })}
      </p>
    );

  return (
    <div data-testid="bank-limits">
      <Panel id="limits-sending" title={t('limitsTitle')} lead={t('limitsLead')}>
        <Select
          label={t('asset')}
          value={assetId}
          onChange={setChosen}
          disabled={assets.length === 0}
          options={assets.map((asset) => asset.assetId)}
        />
        {partner.resource.status === 'failed' && refusal(partner.resource.failure)}
        {heldAtPartner && (
          <>
            <p className="lt-hint">{t('partnerLead', { partner: heldAtPartner.label })}</p>
            <ul
              data-testid="bank-limits-today"
              data-source={heldAtPartner.label}
              data-as-of={heldAtPartner.asOf ?? ''}
              data-daily={heldAtPartner.dailyLimit ?? ''}
              data-used={heldAtPartner.usedToday ?? ''}
              data-remaining={heldAtPartner.remainingToday ?? ''}
            >
              {heldAtPartner.dailyLimit === null ? (
                <li>{t('partnerNotSet', { partner: heldAtPartner.label })}</li>
              ) : (
                <li>{t('partnerDaily', { partner: heldAtPartner.label, amount: heldAtPartner.dailyLimit, asset: assetId })}</li>
              )}
              {heldAtPartner.usedToday !== null && <li>{t('partnerUsed', { amount: heldAtPartner.usedToday, asset: assetId })}</li>}
              {heldAtPartner.remainingToday !== null && (
                <li>{t('partnerRemaining', { amount: heldAtPartner.remainingToday, asset: assetId })}</li>
              )}
            </ul>
          </>
        )}
        {!heldAtPartner && partner.resource.status === 'ready' && quote.resource.status === 'failed' && refusal(quote.resource.failure)}
        {!heldAtPartner && partner.resource.status === 'ready' && quote.resource.status === 'ready' && (
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
      </Panel>
      <Panel id="limits-fees" title={t('feesTitle')}>
        {heldAtPartner && (
          <p data-testid="bank-partner-send-fee" data-state={heldAtPartner.sendFee === null ? 'not-set' : 'set'}>
            {heldAtPartner.sendFee === null
              ? t('partnerFeeNotSet', { partner: heldAtPartner.label })
              : t('partnerFee', { partner: heldAtPartner.label, amount: heldAtPartner.sendFee, asset: assetId })}
          </p>
        )}
        {!heldAtPartner && sendFees.resource.status === 'failed' && refusal(sendFees.resource.failure)}
        {!heldAtPartner && sendFees.resource.status === 'ready' && (
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
            <p className="lt-hint" data-testid="bank-account-fees" data-state="not-set">
              {t('accountFeesNotSet')}
            </p>
          ))}
      </Panel>
      <Panel id="limits-plan" title={t('planTitle')} lead={t('planLead')}>
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
            <table className="lt-table" aria-label={t('plansTable')}>
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
              <p className="lt-hint" data-code="bank.plan_fee_unwired">
                {t('planBlocked')}
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
