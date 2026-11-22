import { useId, useState } from 'react';
import { Button, Field, Select, TextArea } from '@intafaced/ui/lit';
import { FlowTemplate, StatusChip } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource, type Resource } from '../../../shared/resource';
import { payCopy } from '../copy';
import type { PersonalPayApi } from '../pay-api';
import type { CompletionAppeal, Reputation, Trade } from '../schemas';
import { completionCopy } from '../personal/completion-copy';
import { eligibilityReason } from '../personal/Eligibility';
import { eligibilityCopy } from '../personal/p2p-eligibility-copy';
import { Details, Failure, Notice, P2PHead, ReviewedAction, Section, State } from './parts';

/**
 * Trading access (`/p2p/access`, and `/p2p?view=access`): what a person needs before taking an ad, their own completion
 * rate with its one appeal, and their P2P trading programme standing. The kit view of the hub's eligibility panel
 * (`personal/Eligibility.tsx`), the own completion part (`personal/CompletionRates.tsx`) and the programme part that
 * lived in `P2P.tsx`: the same reads, actions and words.
 */
export function AccessRoom({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  // One read of API access: the programme's refresh reloads it, and the summary shows it.
  const access = useResource((signal) => pay.apiAccess(signal), `pay:p2p-api-access:${userId}`);
  return (
    <FlowTemplate
      title={payCopy.t('personToPerson')}
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
      state={{ kind: 'ready' }}
      step={
        <>
          <P2PHead current="/p2p/access" />
          {userId ? <OwnCompletion pay={pay} userId={userId} /> : null}
          <TradingProgramme pay={pay} userId={userId} access={access} />
        </>
      }
      summary={
        <>
          <Eligibility pay={pay} userId={userId} />
          <ApiEligibility access={access} />
        </>
      }
    />
  );
}

/** Every requirement for taking an ad, as `access.eligibility` reports it (the hub's full list, never compact). */
function Eligibility({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { t } = eligibilityCopy.useCopy();
  const eligibility = useResource((signal) => pay.eligibility(signal), `pay:p2p-eligibility:${userId}`);
  return (
    <Section title={t('title')} description={t('intro')}>
      <div aria-label={t('title')} role="region" data-testid="p2p-eligibility">
        <State resource={eligibility.resource} retry={eligibility.reload}>
          {(data) => (
            <>
              <p data-testid={data.canTake ? undefined : 'failure'} className={data.canTake ? 'lt-hint' : undefined} role="status">
                {data.canTake ? t('allMet') : t('someUnmet')}
              </p>
              <ul>
                {data.checks.map((check) => (
                  <li key={check.id} data-check={check.id} data-state={check.state}>
                    <strong>{t(`check_${check.id}` as const)}</strong>{' '}
                    <StatusChip
                      status={check.state === 'met' ? 'done' : check.state === 'not_met' ? 'failed' : 'pending'}
                      label={t(`state_${check.state}` as const)}
                    />
                    <p className="lt-hint">{eligibilityReason(t, check)}</p>
                    {check.state === 'not_met' && check.fix ? (
                      <a className="lt-link" href={check.fix}>
                        {check.id === 'verification' ? t('fix_verification') : t('fix_contact')}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </State>
      </div>
    </Section>
  );
}

/** "95.24" → "95.24%", or a dash when nothing is counted: no finished order is not 0%. */
const percent = (value: string | null | undefined) => (value ? `${value}%` : '—');

/** The 30-day and all-time completion rates, as the service computed them, with the service's words for what they count. */
function CompletionRatesByPeriod({ data }: { data: Reputation }) {
  const { t } = completionCopy.useCopy();
  const definition = data.completionDefinition;
  const none = !data.completionRate30d && !data.completionRateTotal;
  return (
    <section aria-label={t('byPeriod')} data-testid="completion-rates">
      <h3>{t('byPeriod')}</h3>
      <Details
        values={[
          [t('last30'), <strong data-counterparty-metric="completion-30d">{percent(data.completionRate30d)}</strong>],
          [t('allTime'), <strong data-counterparty-metric="completion-total">{percent(data.completionRateTotal)}</strong>],
        ]}
      />
      {definition ? (
        <details>
          <summary>{t('howCounted')}</summary>
          <ul lang="en">
            <li>{t('completedLine', { text: definition.numerator })}</li>
            <li>{t('countedLine', { text: definition.denominator })}</li>
            <li>{t('windowLine', { text: definition.window30d })}</li>
            {none ? <li>{definition.noHistory}</li> : null}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** The person's own completion rate and their one appeal. Support decides it; the room shows what the service holds. */
function OwnCompletion({ pay, userId }: { pay: PersonalPayApi; userId: string }) {
  const { t } = completionCopy.useCopy();
  const record = useResource((signal) => pay.reputation(userId, signal), `pay:own-completion:${userId}`);
  const appeal = useResource((signal) => pay.myAppeal(signal), `pay:my-appeal:${userId}`);
  return (
    <Section title={t('own')}>
      <section aria-label={t('own')}>
        <State resource={record.resource} retry={record.reload}>
          {(data) => <CompletionRatesByPeriod data={data} />}
        </State>
        <State resource={appeal.resource} retry={appeal.reload}>
          {(mine) =>
            mine ? (
              <AppealStatus appeal={mine} />
            ) : (
              <AppealForm
                pay={pay}
                onDone={() => {
                  appeal.reload();
                  record.reload();
                }}
              />
            )
          }
        </State>
      </section>
    </Section>
  );
}

function AppealStatus({ appeal }: { appeal: CompletionAppeal }) {
  const { t, requestedLocale } = completionCopy.useCopy();
  const day = new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short' });
  const text =
    appeal.status === 'submitted'
      ? t('appealSubmitted', { id: appeal.tradeId, due: day.format(new Date(appeal.reviewDueAt)) })
      : t(appeal.status === 'accepted' ? 'appealAccepted' : 'appealRejected', {
          id: appeal.tradeId,
          reason: appeal.decisionReason ?? '',
        });
  return (
    <div role="status" data-testid="appeal-status" data-appeal-status={appeal.status}>
      <p>{text}</p>
      <p className="lt-hint">{t('appealUsed')}</p>
    </div>
  );
}

function AppealForm({ pay, onDone }: { pay: PersonalPayApi; onDone: () => void }) {
  const { t, requestedLocale } = completionCopy.useCopy();
  const formId = useId();
  // The orders an appeal can name: cancelled or disputed after escrow (the ones the rate counts against the person).
  const orders = useResource(
    async (signal): Promise<ApiResult<Trade[]>> => {
      const [cancelled, disputed] = await Promise.all([
        pay.orderPage({ tab: 'cancelled', limit: 200 }, signal),
        pay.orderPage({ tab: 'in_dispute', limit: 200 }, signal),
      ]);
      if (!cancelled.ok) return cancelled;
      if (!disputed.ok) return disputed;
      return { ok: true as const, data: [...disputed.data.trades, ...cancelled.data.trades].filter((trade) => trade.escrowedAt !== null) };
    },
    `pay:appeal-orders:${pay.viewer ?? 'none'}`,
  );
  const [tradeId, setTradeId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<CompletionAppeal>, { ok: false }> | null>(null);
  const day = new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium' });
  const ready = tradeId !== '' && reason.trim() !== '' && !busy;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    const result = await pay.appealCompletion({ tradeId, reason: reason.trim() });
    setBusy(false);
    if (result.ok) onDone();
    else setFailure(result);
  };
  return (
    <State resource={orders.resource} retry={orders.reload}>
      {(list) =>
        list.length === 0 ? (
          <p className="lt-hint">{t('appealNoOrders')}</p>
        ) : (
          <form
            aria-labelledby={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <h3 id={formId}>{t('appealForm')}</h3>
            <p className="lt-hint">{t('appealOnce')}</p>
            <Select label={t('appealOrder')} value={tradeId} onChange={(value) => setTradeId(value)} required>
              <option value="">{t('appealPick')}</option>
              {list.map((trade) => (
                <option key={trade.id} value={trade.id}>
                  {t('appealOrderOption', {
                    id: trade.id,
                    status: t(trade.status === 'disputed' ? 'disputed' : 'cancelled'),
                    when: day.format(new Date(trade.createdAt)),
                  })}
                </option>
              ))}
            </Select>
            <TextArea label={t('appealReason')} value={reason} maxLength={2000} required onChange={(value) => setReason(value)} />
            <Button type="submit" tone="primary" disabled={!ready}>
              {busy ? t('appealSending') : t('appealSend')}
            </Button>
            {failure ? <Failure result={failure} retry={send} /> : null}
          </form>
        )
      }
    </State>
  );
}

type ApiAccess = {
  resource: Resource<Extract<Awaited<ReturnType<PersonalPayApi['apiAccess']>>, { ok: true }>['data']>;
  reload: () => void;
};

/** The person's P2P trading programme: their standing, and the one action it allows (apply, leave or reapply). */
function TradingProgramme({ pay, userId, access }: { pay: PersonalPayApi; userId: string | null; access: ApiAccess }) {
  const [reason, setReason] = useState('');
  const standing = useResource((signal) => pay.standing(signal), `pay:p2p-standing:${userId}`);
  function refresh() {
    standing.reload();
    access.reload();
  }
  return (
    <>
      <Notice title={payCopy.t('p2pTradingStanding')}>{payCopy.t('thisProgrammeIsYourPersonalP2pTrading')}</Notice>
      <Section title={payCopy.t('yourProgrammeStatus')} action={<Button onClick={refresh}>{payCopy.t('refreshStanding')}</Button>}>
        <State resource={standing.resource} retry={standing.reload}>
          {(data) =>
            data ? (
              <div>
                <Details
                  values={[
                    [payCopy.t('standing'), data.status],
                    [payCopy.t('applicationSubmitted'), data.appliedAt],
                    [payCopy.t('decision'), data.decidedAt ?? payCopy.t('notRecorded')],
                    [payCopy.t('tradesAtApplication'), String(data.appliedTradesTotal)],
                  ]}
                />
                {['applied', 'approved', 'suspended'].includes(data.status) && (
                  <>
                    <Field label={payCopy.t('reasonForLeaving')} value={reason} onChange={(event) => setReason(event.target.value)} />
                    <ReviewedAction
                      title={payCopy.t('leaveP2pProgramme')}
                      description={payCopy.t('withdrawYourPersonalP2pProgrammeMembershipYour')}
                      review={<p>{reason}</p>}
                      perform={() => pay.withdrawProgramme(reason.trim())}
                      onConfirmed={refresh}
                      disabled={!reason.trim()}
                    />
                  </>
                )}
                {['rejected', 'withdrawn'].includes(data.status) && (
                  <ReviewedAction
                    title={payCopy.t('reapplyToP2pProgramme')}
                    description={payCopy.t('submitANewApplicationBasedOnCurrent')}
                    perform={() => pay.applyProgramme()}
                    onConfirmed={refresh}
                  />
                )}
              </div>
            ) : (
              <div>
                <p className="lt-hint">{payCopy.t('noP2pProgrammeApplicationExistsForThis')}</p>
                <ReviewedAction
                  title={payCopy.t('applyToP2pProgramme')}
                  description={payCopy.t('submitAnApplicationOnYourOwnBehalf')}
                  perform={() => pay.applyProgramme()}
                  onConfirmed={refresh}
                />
              </div>
            )
          }
        </State>
      </Section>
    </>
  );
}

/** Whether the person's standing lets them use the P2P API, as the service reports it. */
function ApiEligibility({ access }: { access: ApiAccess }) {
  return (
    <Section title={payCopy.t('p2pApiEligibility')}>
      <State resource={access.resource} retry={access.reload}>
        {(data) => (
          <Details
            values={[
              [
                payCopy.t('apiStanding'),
                data.eligible ? payCopy.t('eligibleByCurrentProgrammeStanding') : payCopy.t('notEligibleByCurrentProgrammeStanding'),
              ],
              [payCopy.t('currentCredential'), data.credential],
              [payCopy.t('disputeDecisions'), payCopy.t('interactiveHumanOnly')],
            ]}
          />
        )}
      </State>
    </Section>
  );
}
