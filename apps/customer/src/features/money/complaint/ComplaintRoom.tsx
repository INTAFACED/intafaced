// volt-room: /bank/safety/complaint
import { useState, type FormEvent } from 'react';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { SupportComplaintTopic } from '@intafaced/contracts/support-safety';
import { useSession } from '../../session';
import { safetyCopy, type SafetyCopyKey } from '../safety-copy';
import { Acknowledgement, EarlierAcknowledgements, safetyState, useMyAcknowledgements, useSafetySend, sendComplaint } from '../safety-ack';

/**
 * Make a complaint (BK-safe-03, J-bank-18 #5), on the flow template. `support.safety.complain` makes one complaint request
 * on the support desk and acknowledges it once, with a reference and the final-response deadline from the owner's limit,
 * or "not set" while the owner has published none. The same form sent again shows the same acknowledgement.
 */

const TOPICS: readonly [SupportComplaintTopic, Extract<SafetyCopyKey, `topic${string}`>][] = [
  ['account', 'topicAccount'],
  ['cards', 'topicCards'],
  ['payments', 'topicPayments'],
  ['trading', 'topicTrading'],
  ['support', 'topicSupport'],
  ['other', 'topicOther'],
];

export function ComplaintRoom() {
  const { t } = safetyCopy.useCopy();
  const { userId } = useSession();
  const [topic, setTopic] = useState<SupportComplaintTopic>('account');
  const [details, setDetails] = useState('');
  const [outcome, setOutcome] = useState('');
  const { send, busy, sent, refusal } = useSafetySend('complaint', sendComplaint);
  const earlier = useMyAcknowledgements('complaint', sent?.id ?? null);
  const ready = details.trim().length >= 10;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const ok = await send({ topic, details: details.trim(), ...(outcome.trim() ? { outcome: outcome.trim() } : {}) });
    if (ok) {
      setDetails('');
      setOutcome('');
    }
  }

  return (
    <FlowTemplate
      title={t('complaintTitle')}
      description={t('complaintDescription')}
      state={safetyState(Boolean(userId), refusal, t, '/bank/safety/complaint')}
      step={
        <div>
          {sent ? <Acknowledgement ack={sent} title={t('complaintReceived')} live /> : null}
          <form aria-label={t('complaintTitle')} onSubmit={(e) => void submit(e)}>
            <label className="lt-field">
              <span>{t('topicLabel')}</span>
              <select name="topic" value={topic} onChange={(e) => setTopic(e.target.value as SupportComplaintTopic)}>
                {TOPICS.map(([value, key]) => (
                  <option key={value} value={value}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="lt-field">
              <span>{t('detailsLabel')}</span>
              <textarea
                name="details"
                value={details}
                maxLength={5000}
                rows={6}
                onChange={(e) => setDetails(e.target.value)}
                aria-describedby="complaint-details-hint"
              />
              <small id="complaint-details-hint">{t('detailsHint')}</small>
            </label>
            <label className="lt-field">
              <span>{t('outcomeLabel')}</span>
              <textarea name="outcome" value={outcome} maxLength={2000} rows={3} onChange={(e) => setOutcome(e.target.value)} />
            </label>
            <Button type="submit" tone="primary" aria-busy={busy || undefined} disabled={busy || !ready}>
              {t('sendComplaint')}
            </Button>
          </form>
        </div>
      }
      summary={
        <div>
          <h2>{t('complaintSummaryTitle')}</h2>
          <p>{t('complaintSummaryAck')}</p>
          <p>{t('complaintSummaryDeadline')}</p>
          <p>{t('complaintSummaryNoFee')}</p>
          {userId ? (
            <EarlierAcknowledgements kind="complaint" heading={t('yourComplaints')} none={t('noComplaints')} resource={earlier.resource} />
          ) : null}
        </div>
      }
    />
  );
}
