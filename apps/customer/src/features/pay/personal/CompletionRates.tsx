import { useId, useState } from 'react';
import { Button } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { PayFailure, PaySection, PayState } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { CompletionAppeal, Reputation, Trade } from '../schemas';
import { completionCopy } from './completion-copy';

/** "95.24" → "95.24%", or a dash when nothing is counted: no finished order is not 0%. */
const percent = (value: string | null | undefined) => (value ? `${value}%` : '—');

/**
 * P-trade-orders-21: the 30-day and all-time completion rates, as the service computed them from trades, with the
 * service's own words for what they count.
 */
export function CompletionRatesByPeriod({ data }: { data: Reputation }) {
  const { t } = completionCopy.useCopy();
  const definition = data.completionDefinition;
  const none = !data.completionRate30d && !data.completionRateTotal;
  return (
    <section aria-label={t('byPeriod')} className="stack" data-testid="completion-rates">
      <h3>{t('byPeriod')}</h3>
      <dl className="pay-details">
        <div>
          <dt>{t('last30')}</dt>
          <dd>
            <strong data-counterparty-metric="completion-30d">{percent(data.completionRate30d)}</strong>
          </dd>
        </div>
        <div>
          <dt>{t('allTime')}</dt>
          <dd>
            <strong data-counterparty-metric="completion-total">{percent(data.completionRateTotal)}</strong>
          </dd>
        </div>
      </dl>
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

/**
 * The person's own completion rate on their trading page, and their one appeal: an order they were a party to that
 * reached escrow and ended cancelled or disputed, with a reason. Support decides it; the page shows what the service
 * holds, never a guess.
 */
export function OwnCompletion({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  return userId ? <OwnCompletionOf pay={pay} userId={userId} /> : null;
}

function OwnCompletionOf({ pay, userId }: { pay: PersonalPayApi; userId: string }) {
  const { t } = completionCopy.useCopy();
  const record = useResource((signal) => pay.reputation(userId, signal), `pay:own-completion:${userId}`);
  const appeal = useResource((signal) => pay.myAppeal(signal), `pay:my-appeal:${userId}`);
  return (
    <PaySection title={t('own')}>
      <section aria-label={t('own')} className="stack">
        <PayState resource={record.resource} retry={record.reload}>
          {(data) => <CompletionRatesByPeriod data={data} />}
        </PayState>
        <PayState resource={appeal.resource} retry={appeal.reload}>
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
        </PayState>
      </section>
    </PaySection>
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
      <p className="muted">{t('appealUsed')}</p>
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
        pay.orderPage({ tab: 'cancelled', limit: 50 }, signal),
        pay.orderPage({ tab: 'in_dispute', limit: 50 }, signal),
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
    <PayState resource={orders.resource} retry={orders.reload}>
      {(list) =>
        list.length === 0 ? (
          <p className="muted">{t('appealNoOrders')}</p>
        ) : (
          <form
            className="form-stack"
            aria-labelledby={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <h3 id={formId}>{t('appealForm')}</h3>
            <p className="muted">{t('appealOnce')}</p>
            <label className="field">
              <span>{t('appealOrder')}</span>
              <select value={tradeId} onChange={(event) => setTradeId(event.target.value)} required>
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
              </select>
            </label>
            <label className="field">
              <span>{t('appealReason')}</span>
              <textarea value={reason} maxLength={2000} required onChange={(event) => setReason(event.target.value)} />
            </label>
            <Button type="submit" disabled={!ready}>
              {busy ? t('appealSending') : t('appealSend')}
            </Button>
            {failure ? <PayFailure result={failure} retry={send} /> : null}
          </form>
        )
      }
    </PayState>
  );
}
