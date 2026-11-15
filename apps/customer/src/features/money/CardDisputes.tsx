import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { displayAmount } from '../../shared/money';
import { Button, Field } from '../../shared/ui';
import { useSession } from '../session/session';
import { ResourceView, useBankRead } from './components';
import { bankWrites, type cardSchema } from './contracts';
import { DepthPanel } from './DepthParts';
import { Refusal } from './CardJourney';
import { cardDisputesCopy } from './card-disputes-copy';
import { withPlainRefusal } from './money-refusal-copy';

/**
 * A cardholder's own card disputes (J-bank-15; BK-cdisp-01, svc-bank `cards.disputes.*`). Pressing Dispute this charge on
 * a payment opens a form prefilled from it, with the card partner's window and evidence rule and the cases that cannot be
 * disputed. A filed case shows its tracker (each state with its date and who took it), the partner's provisional credit
 * and any reversal as the partner reports them, and the decision with its reason. Nothing here moves money.
 */

type CardRecord = z.infer<typeof cardSchema>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const timeOf = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function CardDisputesPanel({ card }: { card: CardRecord }) {
  const { t } = cardDisputesCopy.useCopy();
  const payments = useBankRead('cards.authorizations', { cardId: card.id, limit: 50 });
  const cases = useBankRead('cards.disputes.list', { cardId: card.id });
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <DepthPanel title={t('title')} lead={t('lead')}>
      <ResourceView resource={cases.resource} reload={cases.reload}>
        {(rows) => {
          const disputed = new Set(rows.map((r) => r.authorizationRef));
          return (
            <>
              <ResourceView resource={payments.resource} reload={payments.reload}>
                {(list) => {
                  const approved = list.filter((p) => p.decision === 'approved');
                  if (!approved.length) return <p className="muted">{t('noPayments')}</p>;
                  return (
                    <ul aria-label={t('payments')}>
                      {approved.map((p) => (
                        <li key={p.id} data-authorization={p.authorizationRef}>
                          {t('paymentLine', {
                            amount: `${displayAmount(p.amount)} ${card.assetId}`,
                            merchant: p.merchant ?? t('anyMerchant'),
                            ref: p.authorizationRef,
                          })}{' '}
                          {disputed.has(p.authorizationRef) ? (
                            t('disputed')
                          ) : (
                            <Button variant="secondary" onClick={() => setChosen(p.authorizationRef)}>
                              {t('disputeThis')}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  );
                }}
              </ResourceView>
              {chosen && !disputed.has(chosen) && (
                <DisputeForm
                  key={chosen}
                  card={card}
                  authorizationRef={chosen}
                  onClose={() => setChosen(null)}
                  onFiled={() => {
                    setChosen(null);
                    cases.reload();
                  }}
                />
              )}
              {rows.length > 0 && (
                <section aria-label={t('casesTitle')}>
                  <h4>{t('casesTitle')}</h4>
                  {rows.map((r) => (
                    <DisputeTracker key={r.id} disputeId={r.id} onChange={cases.reload} />
                  ))}
                </section>
              )}
            </>
          );
        }}
      </ResourceView>
    </DepthPanel>
  );
}

function DisputeForm({
  card,
  authorizationRef,
  onClose,
  onFiled,
}: {
  card: CardRecord;
  authorizationRef: string;
  onClose: () => void;
  onFiled: () => void;
}) {
  const { api } = useSession();
  const { t } = cardDisputesCopy.useCopy();
  const form = useBankRead('cards.disputes.form', { cardId: card.id, authorizationRef });
  const [amount, setAmount] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);

  return (
    <section role="region" aria-label={t('formTitle')} data-authorization={authorizationRef}>
      <h4>{t('formTitle')}</h4>
      <ResourceView resource={form.resource} reload={form.reload}>
        {(f) => {
          const asset = f.charge.assetId;
          async function file(event: FormEvent) {
            event.preventDefault();
            setBusy(true);
            setFailure(null);
            const done = await api.mutate(
              'bank',
              'cards.disputes.open',
              { cardId: card.id, authorizationRef, amount: amount ?? f.charge.disputable, reason },
              bankWrites['cards.disputes.open'],
            );
            setBusy(false);
            if (!done.ok) return setFailure(withPlainRefusal(done));
            onFiled();
          }
          return (
            <>
              {f.test && <p className="money-caption">{t('testRules')}</p>}
              <dl className="bd-facts">
                <div>
                  <dt>{t('chargeRef')}</dt>
                  <dd lang="zxx" dir="ltr">
                    {f.charge.authorizationRef}
                  </dd>
                </div>
                <div>
                  <dt>{t('chargeMerchant')}</dt>
                  <dd>{f.charge.merchant ?? t('anyMerchant')}</dd>
                </div>
                <div>
                  <dt>{t('chargeCaptured')}</dt>
                  <dd>{`${displayAmount(f.charge.captured)} ${asset}`}</dd>
                </div>
              </dl>
              <p data-testid="dispute-window">
                {f.rules
                  ? t('windowRule', { days: String(f.rules.windowDays), deadline: f.deadline ? timeOf(f.deadline) : '—' })
                  : t('windowUnset')}
              </p>
              {f.rules && (
                <p data-testid="dispute-evidence-rule">
                  {f.rules.evidenceAfterSubmission ? t('evidenceUntilDecided') : t('evidenceUntilSubmitted')}
                </p>
              )}
              <h5>{t('ineligibleTitle')}</h5>
              <ul aria-label={t('ineligibleTitle')}>
                <li>{t('ineligibleDeclined')}</li>
                <li>{t('ineligibleNotSettled')}</li>
                <li>{t('ineligibleRefunded')}</li>
                <li>{t('ineligibleDisputed')}</li>
                <li>{t('ineligibleWindow')}</li>
              </ul>
              {f.standing === 'disputable' ? (
                <form className="form-stack" onSubmit={(e) => void file(e)}>
                  <Field
                    label={t('amount', { asset })}
                    hint={t('amountHint', { amount: displayAmount(f.charge.disputable), asset })}
                    name="amount"
                    inputMode="decimal"
                    value={amount ?? f.charge.disputable}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                  <Field label={t('reason')} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
                  <div className="actions">
                    <Button type="submit" disabled={busy}>
                      {t('file')}
                    </Button>
                    <Button type="button" variant="ghost" onClick={onClose}>
                      {t('cancel')}
                    </Button>
                  </div>
                </form>
              ) : (
                <p role="status" data-standing={f.standing}>
                  {t(`standing_${f.standing}`)}
                </p>
              )}
            </>
          );
        }}
      </ResourceView>
      {failure && <Refusal failure={failure} />}
    </section>
  );
}

function DisputeTracker({ disputeId, onChange }: { disputeId: string; onChange: () => void }) {
  const { api } = useSession();
  const { t } = cardDisputesCopy.useCopy();
  const read = useBankRead('cards.disputes.get', { disputeId });
  const [evidence, setEvidence] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);

  async function act(procedure: 'cards.disputes.evidence' | 'cards.disputes.withdraw', input: Record<string, string>) {
    setBusy(true);
    setFailure(null);
    const done = await api.mutate('bank', procedure, { disputeId, ...input }, bankWrites[procedure]);
    setBusy(false);
    if (!done.ok) return setFailure(withPlainRefusal(done));
    setEvidence('');
    setWhy('');
    read.reload();
    onChange();
  }

  return (
    <ResourceView resource={read.resource} reload={read.reload}>
      {(c) => {
        const credit = c.provisionalCredit;
        return (
          <article
            role="region"
            aria-label={t('caseTitle', { ref: c.authorizationRef })}
            data-dispute={c.id}
            data-state={c.state}
            className="form-stack"
          >
            <h5>{t('caseTitle', { ref: c.authorizationRef })}</h5>
            <p>{t('caseLine', { amount: displayAmount(c.amount), asset: c.assetId, reason: c.reason })}</p>
            {c.test && <p className="money-caption">{t('testCase')}</p>}
            <p data-testid="dispute-state">{t('stateNow', { state: t(`state_${c.state}`) })}</p>
            <ol aria-label={t('tracker')}>
              {c.events.map((e) => (
                <li key={e.sequence} data-kind={e.kind} data-to={e.toState}>
                  {t('eventLine', { step: t(`event_${e.kind}`), time: timeOf(e.at), by: t(`by_${e.by}`) })}
                  {e.detail ? `: ${e.detail}` : ''}
                  {e.afterSubmission ? ` (${t('afterSubmission')})` : ''}
                </li>
              ))}
            </ol>
            <p data-testid="dispute-credit" data-credit={credit.state}>
              {credit.state === 'credited' && credit.amount && credit.partnerRef
                ? t('creditCredited', { amount: displayAmount(credit.amount), asset: c.assetId, ref: credit.partnerRef })
                : credit.state === 'asked'
                  ? t('creditAsked')
                  : t('creditNone')}
            </p>
            {c.decision && (
              <div data-testid="dispute-decision" data-outcome={c.decision.outcome}>
                <p>{t(`outcome_${c.decision.outcome}`)}</p>
                <p>{c.decision.reason ? t('decisionReason', { reason: c.decision.reason }) : t('decisionNoReason')}</p>
                {c.decision.creditSettlement && credit.amount && (
                  <p data-testid="dispute-settlement" data-settlement={c.decision.creditSettlement}>
                    {t(c.decision.creditSettlement === 'final' ? 'settlementFinal' : 'settlementReversed', {
                      amount: displayAmount(credit.amount),
                      asset: c.assetId,
                      ref: c.decision.creditSettlementPartnerRef ?? '—',
                    })}
                  </p>
                )}
              </div>
            )}
            {c.state !== 'closed' && (
              <>
                <form
                  className="form-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('cards.disputes.evidence', { description: evidence });
                  }}
                >
                  <Field label={t('evidence')} name="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)} required />
                  <Button type="submit" variant="secondary" disabled={busy}>
                    {t('addEvidence')}
                  </Button>
                </form>
                <form
                  className="form-stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('cards.disputes.withdraw', { reason: why });
                  }}
                >
                  <Field label={t('withdrawReason')} name="withdraw-reason" value={why} onChange={(e) => setWhy(e.target.value)} required />
                  <Button type="submit" variant="ghost" disabled={busy}>
                    {t('withdraw')}
                  </Button>
                </form>
              </>
            )}
            {failure && <Refusal failure={failure} />}
          </article>
        );
      }}
    </ResourceView>
  );
}
