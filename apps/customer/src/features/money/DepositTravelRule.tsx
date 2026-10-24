import { useState, type FormEvent } from 'react';
import { PAY_DEPOSIT_WALLET_TYPES, type PayDepositWalletType, type PayTravelRuleField } from '@intafaced/contracts/pay-custody-deposit';
import { Button } from '../../shared/ui';
import { displayAmount } from '../../shared/money';
import { writeContract } from '../../shared/contract-call';
import { useSession } from '../session/session';
import { ReportedTime } from './bank-context';
import { depositRecordsCopy } from './deposit-records-copy';
import { depositTravelRuleDeclare, useDepositTravelRule, type DepositTravelRuleView } from './deposit-reads';

/** svc-pay's refusals this form explains in its own words; any other reads as the service wrote it. */
const REFUSALS = ['travel_rule.fields_missing', 'travel_rule.cipher_unwired', 'travel_rule.deposit_state_refused'] as const;
type Refusal = (typeof REFUSALS)[number];
const refusalOf = (code: string | undefined, message: string | undefined): Refusal | null =>
  REFUSALS.find((r) => code === r || message?.startsWith(`${r}:`)) ?? null;

/**
 * A deposit held for the inbound travel rule (W-deposit-07, J-wallet-03 #1-#3), under its row in Deposit records. While it
 * awaits a declaration the depositor names where it came from and every field the owner asked for; svc-pay seals the values
 * and never sends them back. Afterwards it says where compliance stands. Nothing here moves money: a person releases it.
 */
export function DepositTravelRulePanel({ depositId, onChanged }: { depositId: string; onChanged: () => void }) {
  const { t } = depositRecordsCopy.useCopy();
  const { resource, reload } = useDepositTravelRule(depositId);
  if (resource.status === 'loading') {
    return (
      <p className="money-caption" role="status">
        {t('trLoading')}
      </p>
    );
  }
  if (resource.status === 'failed') {
    return (
      <div className="money-caption" role="status">
        {t('trLoadFailed')}{' '}
        <Button variant="secondary" onClick={reload}>
          {t('pendingRetry')}
        </Button>
      </div>
    );
  }
  const view = resource.data;
  return (
    <section className="bd-travel-rule" data-testid="deposit-travel-rule" data-state={view.state} aria-label={t('trTitle')}>
      <strong>{t('trTitle')}</strong>
      <p className="money-caption">
        {t('trLead', { amount: displayAmount(view.amount), threshold: displayAmount(view.threshold), asset: view.assetId })}
      </p>
      {view.state === 'awaiting_declaration' ? (
        <DeclarationForm
          view={view}
          onDeclared={() => {
            reload();
            onChanged();
          }}
        />
      ) : (
        <TravelRuleState view={view} />
      )}
    </section>
  );
}

function TravelRuleState({ view }: { view: DepositTravelRuleView }) {
  const { t } = depositRecordsCopy.useCopy();
  if (view.state === 'counterparty_pending' && view.waitDeadline) {
    return (
      <p role="status">
        {t('trWaiting')} <ReportedTime value={view.waitDeadline} />. {t('trWaitingNote')}
      </p>
    );
  }
  const key = view.state === 'blocking_time_expired' ? 'trExpired' : view.state === 'released' ? 'trReleased' : 'trDeclared';
  return <p role="status">{t(key)}</p>;
}

function DeclarationForm({ view, onDeclared }: { view: DepositTravelRuleView; onDeclared: () => void }) {
  const { t } = depositRecordsCopy.useCopy();
  const { api } = useSession();
  const [walletType, setWalletType] = useState<PayDepositWalletType | null>(null);
  const [values, setValues] = useState<Partial<Record<PayTravelRuleField, string>>>({});
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const missing = view.requiredFields.some((f) => !values[f]?.trim());
    if (!walletType || missing) {
      setProblem(t('trMissing'));
      return;
    }
    setSending(true);
    setProblem(null);
    const fields = Object.fromEntries(view.requiredFields.map((f) => [f, values[f]!.trim()]));
    const result = await writeContract(api, depositTravelRuleDeclare, { depositId: view.depositId, walletType, fields });
    setSending(false);
    if (result.ok) {
      onDeclared();
      return;
    }
    const refusal = refusalOf(result.code, result.message);
    setProblem(
      refusal
        ? t(`trRefused_${refusal.slice('travel_rule.'.length) as 'fields_missing' | 'cipher_unwired' | 'deposit_state_refused'}`)
        : t('trRefused_other', { message: result.message ?? result.reason }),
    );
  };

  return (
    <form className="bd-filter" data-testid="deposit-travel-rule-form" onSubmit={(event) => void submit(event)} noValidate>
      <fieldset className="field">
        <legend>{t('trWalletType')}</legend>
        {PAY_DEPOSIT_WALLET_TYPES.map((type) => (
          <label key={type}>
            <input type="radio" name={`wallet-${view.depositId}`} checked={walletType === type} onChange={() => setWalletType(type)} />{' '}
            {t(`trWallet_${type}`)}
          </label>
        ))}
      </fieldset>
      {view.requiredFields.map((field) => (
        <label key={field} className="field">
          <span>{t(`field_${field}`)}</span>
          <input
            value={values[field] ?? ''}
            maxLength={500}
            required
            onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))}
          />
        </label>
      ))}
      {problem && (
        <p role="alert" className="money-caption">
          {problem}
        </p>
      )}
      <Button type="submit" disabled={sending}>
        {sending ? t('trSending') : t('trSubmit')}
      </Button>
    </form>
  );
}
