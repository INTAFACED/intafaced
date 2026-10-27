import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { referrerChangeCopy as copy } from './referrer-change-copy';

// The person's reviewed referrer change (CM-referral-01, J-campaigns-05 #5 and #6): the latest request and its state,
// and, after a link attach was refused, the offer to ask for one. A second person decides; this screen never does.
// hand-declared-ok: svc-identity's affiliates procedures have no browser-safe schema in packages/contracts yet
export const rebindSchema = z.object({
  requestId: z.string().uuid(),
  state: z.enum(['submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'expired']),
  fromReferrerId: z.string().uuid().nullable(),
  toReferrerId: z.string().uuid(),
  reason: z.string(),
  decisionReason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  reviewEndsAt: z.string().datetime({ offset: true }).nullable(),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  appliedAt: z.string().datetime({ offset: true }).nullable(),
});
type Rebind = z.infer<typeof rebindSchema>;
type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

const REFUSAL_COPY: Record<string, 'rebindOpen' | 'rebindNotNeeded' | 'sameReferrer' | 'revoked' | 'reviewUnset'> = {
  'referral.rebind_open': 'rebindOpen',
  'referral.rebind_not_needed': 'rebindNotNeeded',
  'referral.already_set': 'sameReferrer',
  'share.revoked': 'revoked',
  'action_approval.ttl_unset': 'reviewUnset',
};
const OPEN = new Set<Rebind['state']>(['submitted', 'under_review']);

export function ReferrerChange({ offerToken }: { offerToken: string | null }) {
  const { api } = useSession();
  const { t, requestedLocale } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'affiliates.myRebind', undefined, rebindSchema.nullable(), { signal }),
    'referral-rebind',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const when = (value: string) =>
    `${new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;

  async function send(run: () => Promise<ApiResult<Rebind>>) {
    setBusy(true);
    setRefused(null);
    const answer = await run();
    setBusy(false);
    // Success or not, the stored request is re-read; a lost reply is never answered by sending again.
    if (!answer.ok) setRefused(answer);
    reload();
  }
  const request = (token: string) =>
    send(() => api.mutate('identity', 'affiliates.requestRebind', { token, reason: reason.trim() }, rebindSchema));
  const withdraw = (requestId: string) => send(() => api.mutate('identity', 'affiliates.withdrawRebind', { requestId }, rebindSchema));

  const latest = resource.status === 'ready' ? resource.data : null;
  // A request saved but not yet filed is filed by asking again, so only one under review hides the offer.
  const canOffer = offerToken !== null && resource.status === 'ready' && latest?.state !== 'under_review';
  return (
    <section className="invitation__window invitation__change" aria-label={t('title')}>
      <h3>{t('title')}</h3>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'failed' ? (
        <div lang="und">
          <Failure result={resource.failure} retry={reload} />
        </div>
      ) : !latest ? (
        <p className="muted">{t('none')}</p>
      ) : (
        <div>
          <p role="status" data-rebind={latest.state}>
            {t(latest.state, {
              reviewEndsAt: latest.reviewEndsAt ? when(latest.reviewEndsAt) : '',
              appliedAt: latest.appliedAt ? when(latest.appliedAt) : '',
            })}
          </p>
          <dl>
            <div>
              <dt>{t('toReferrer')}</dt>
              <dd lang="zxx" data-testid="invitation__private" className="invitation__private">
                {latest.toReferrerId}
              </dd>
            </div>
            <div>
              <dt>{t('requested')}</dt>
              <dd lang="zxx">
                <time dateTime={latest.createdAt}>{when(latest.createdAt)}</time>
              </dd>
            </div>
            <div>
              <dt>{t('yourReason')}</dt>
              <dd lang="und">{latest.reason}</dd>
            </div>
            {latest.decisionReason && (
              <div>
                <dt>{t('decisionReason')}</dt>
                <dd lang="und">{latest.decisionReason}</dd>
              </div>
            )}
          </dl>
          {OPEN.has(latest.state) && (
            <Button variant="secondary" disabled={busy} onClick={() => void withdraw(latest.requestId)}>
              {t('withdraw')}
            </Button>
          )}
        </div>
      )}
      {canOffer && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void request(offerToken);
          }}
        >
          <h4>{t('offerTitle')}</h4>
          <p className="muted">{t('offerBody')}</p>
          <label htmlFor="referrer-change-reason">{t('reasonLabel')}</label>
          <textarea
            id="referrer-change-reason"
            value={reason}
            minLength={3}
            maxLength={500}
            required
            aria-describedby="referrer-change-help"
            onChange={(event) => setReason(event.target.value)}
          />
          <p id="referrer-change-help" className="muted">
            {t('reasonHelp')}
          </p>
          <Button type="submit" disabled={busy || reason.trim().length < 3}>
            {t(busy ? 'sending' : 'submit')}
          </Button>
        </form>
      )}
      {refused &&
        (refused.code ? (
          <div role="alert">
            <p>{t(REFUSAL_COPY[refused.code] ?? 'refused')}</p>
            <p lang="zxx">
              HTTP {refused.status} · {refused.code}
            </p>
          </div>
        ) : (
          <div lang="und">
            <Failure result={refused} />
          </div>
        ))}
    </section>
  );
}
