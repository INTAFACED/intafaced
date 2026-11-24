// volt-room: /copy/lead/apply
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@intafaced/ui';
import { FlowTemplate, KeyValue, formatMoney } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import { isVerifyFirst, type ApiResult } from '../../../shared/api';
import { verifyFirstRefusal } from '../../../shared/verify-first';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { leadApplyCopy } from './lead-apply-copy';
import {
  TRADE_COPY_MY_LEAD_APPLICATION,
  TRADE_COPY_LEAD_ELIGIBILITY,
  TRADE_COPY_APPLY_TO_LEAD,
} from '@intafaced/contracts/trade-copy-records';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

type Mine = ProcedureOutput<typeof TRADE_COPY_APPLY_TO_LEAD>;
type Eligibility = ProcedureOutput<typeof TRADE_COPY_LEAD_ELIGIBILITY>;

type T = ReturnType<typeof leadApplyCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** svc-trade's code: the code that ends the message in square brackets, or the error cause. */
function codeOf(failure: Failed): string | undefined {
  return /\[([a-z_.]+)\]\s*$/.exec(failure.message ?? '')?.[1] ?? failure.code;
}

/** A refused application, in the room's own words: the service's sentence is never shown. */
function applyRefusal(failure: Failed, t: T, terms: Eligibility | null): Refusal {
  const code = codeOf(failure);
  const reference = code ?? failure.reason;
  if (code === 'trade.copy_lead_following') {
    const name = terms?.following?.displayName;
    return {
      variant: 'refused',
      title: t('followingTitle'),
      body: name ? t('followingBody', { name }) : t('followingBodyUnnamed'),
      reference,
    };
  }
  if (code === 'trade.copy_lead_balance_threshold_unset')
    return { variant: 'refused', title: t('thresholdTitle'), body: t('thresholdBody'), reference };
  if (code === 'trade.copy_lead_venue_account_missing')
    return { variant: 'refused', title: t('venueMissingTitle'), body: t('venueMissingBody'), reference };
  if (code === 'trade.copy_lead_venue_unreadable')
    return { variant: 'unreachable', title: t('venueUnreadableTitle'), body: t('venueUnreadableBody'), reference };
  if (code === 'trade.copy_lead_balance_below') {
    const threshold = terms?.threshold;
    return {
      variant: 'refused',
      title: t('belowTitle'),
      body: threshold ? t('belowBody', { threshold: formatMoney({ value: threshold, asset: 'USDC' }) }) : t('belowBodyUnnamed'),
      reference,
    };
  }
  if (code === 'trade.copy_lead_application_open') return { variant: 'refused', title: t('openTitle'), body: t('openBody'), reference };
  if (code === 'trade.copy_lead_already_leading')
    return { variant: 'refused', title: t('leadingTitle'), body: t('leadingBody'), reference };
  if (code === 'trade.copy_lead_name_invalid') return { variant: 'refused', title: t('nameTitle'), body: t('nameBody'), reference };
  if (code === 'trade.copy_lead_reapply_wait_unset') return { variant: 'refused', title: t('waitTitle'), body: t('waitBody'), reference };
  if (code === 'trade.copy_lead_reapply_wait')
    return { variant: 'refused', title: t('waitRunningTitle'), body: t('waitRunningBody'), reference };
  return {
    variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
    title: t('refusedTitle'),
    body: failure.reason === 'uncertain' ? t('uncertainBody') : t('otherBody'),
    reference,
  };
}

export function LeadApplyRoom() {
  const { t } = leadApplyCopy.useCopy();
  const { api, userId } = useSession();
  const mine = useResource(
    (signal) =>
      userId ? api.call(TRADE_COPY_MY_LEAD_APPLICATION, undefined, { signal }) : Promise.resolve({ ok: true as const, data: null }),
    `lead-apply:${userId ?? 'out'}`,
  );
  const terms = useResource(
    (signal) =>
      userId ? api.call(TRADE_COPY_LEAD_ELIGIBILITY, undefined, { signal }) : Promise.resolve({ ok: true as const, data: null }),
    `lead-terms:${userId ?? 'out'}`,
  );
  const eligibility = terms.resource.status === 'ready' ? terms.resource.data : null;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [sent, setSent] = useState<Mine | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const nameId = useId();

  const current = sent ?? (mine.resource.status === 'ready' ? mine.resource.data : null);
  // After a rejection, applying again opens once the platform's wait has passed from the decision; with the wait unset
  // it never opens, so only a first application is offered.
  const reapplyAfter = current?.state === 'disapproved' ? current.reapplyAfter : null;
  // The page's clock, moved on when the wait ends (a long wait in steps a browser timer can hold). If this device's clock
  // runs ahead, svc-trade still refuses an early application by the wait's code, and the room says so.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!reapplyAfter) return;
    const left = Date.parse(reapplyAfter) - clock;
    if (left <= 0) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(left + 250, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [reapplyAfter, clock]);
  const waitOver = reapplyAfter !== null && Date.parse(reapplyAfter) <= clock;
  const canApply = !current || waitOver;

  async function apply(e: FormEvent) {
    e.preventDefault();
    // One request per submit, and never a second while the first has no answer.
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    const out = await api.call(TRADE_COPY_APPLY_TO_LEAD, { displayName: name.trim() });
    if (out.ok) {
      sending.current = false;
      setBusy(false);
      setSent(out.data);
      return;
    }
    // The refusal names what svc-trade measured now (whom you follow, the threshold), so read the terms again first.
    const now = await api.call(TRADE_COPY_LEAD_ELIGIBILITY, undefined);
    sending.current = false;
    setBusy(false);
    setRefusal(applyRefusal(out, t, now.ok ? now.data : eligibility));
    terms.reload();
  }

  const state: RoomState = useMemo(() => {
    if (!userId)
      return {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Fcopy%2Flead%2Fapply' },
        },
      };
    if (mine.resource.status === 'loading') return { kind: 'loading' };
    if (mine.resource.status === 'failed' && isVerifyFirst(mine.resource.failure))
      return { kind: 'refused', refusal: verifyFirstRefusal() };
    if (mine.resource.status === 'failed')
      return {
        kind: 'refused',
        refusal: {
          variant: 'unreachable',
          title: t('readFailedTitle'),
          body: t('readFailedBody'),
          reference: codeOf(mine.resource.failure) ?? mine.resource.failure.reason,
          action: { label: t('tryAgain'), href: '/copy/lead/apply' },
        },
      };
    if (refusal) return { kind: 'ready', partial: { missing: refusal } };
    // After a rejection with the platform's waiting period unset, applying again is refused by name.
    if (current?.state === 'disapproved' && current.reapplyAfter === null)
      return {
        kind: 'ready',
        partial: {
          missing: { variant: 'refused', title: t('waitTitle'), body: t('waitBody'), reference: 'trade.copy_lead_reapply_wait_unset' },
        },
      };
    return { kind: 'ready' };
  }, [userId, mine.resource, refusal, current?.state, current?.reapplyAfter, t]);

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      step={
        <div className="lead-apply">
          {sent ? <p role="status">{t('sent')}</p> : null}
          {!sent && (current?.state === 'submitted' || current?.state === 'under_review') ? (
            <p>{t('waiting', { name: current.displayName })}</p>
          ) : null}
          {current?.state === 'approved' ? (
            <p>
              {t('approved', { name: current.displayName })} <a href="/trade/copy">{t('openCopy')}</a>
            </p>
          ) : null}
          {current?.state === 'disapproved' ? <p>{t('rejected', { name: current.displayName, reason: current.reason ?? '' })}</p> : null}
          {reapplyAfter ? (
            <p>
              {waitOver ? t('reapplyOpen') : t('reapplyAfter')}{' '}
              <time dateTime={reapplyAfter} data-testid="reapply-after">
                {new Date(reapplyAfter).toLocaleString()}
              </time>
            </p>
          ) : null}
          {canApply ? (
            <form aria-label={t('title')} onSubmit={(e) => void apply(e)}>
              <Field label={t('nameLabel')} hint={t('nameHint')}>
                <Input id={nameId} value={name} onValueChange={setName} maxLength={80} autoComplete="nickname" />
              </Field>
              <Button type="submit" variant="primary" loading={busy} disabled={busy}>
                {t('apply')}
              </Button>
            </form>
          ) : null}
        </div>
      }
      summary={
        <div>
          {userId ? <LeadTerms terms={eligibility} failed={terms.resource.status === 'failed'} t={t} /> : null}
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summaryReview')}</p>
          <p>{t('summaryRecord')}</p>
        </div>
      }
    />
  );
}

/** What applying to lead is measured by, as svc-trade read it for this person: whom they follow, the threshold, their venue USDC. */
function LeadTerms({ terms, failed, t }: { terms: Eligibility | null; failed: boolean; t: T }) {
  if (!terms) return failed ? <p>{t('termsFailed')}</p> : null;
  const venue = terms.venue;
  return (
    <section aria-label={t('termsTitle')}>
      <h2>{t('termsTitle')}</h2>
      <KeyValue
        label={t('termsTitle')}
        rows={[
          {
            label: t('termsFollowing'),
            value: terms.following ? t('termsFollowingYes', { name: terms.following.displayName }) : t('termsFollowingNo'),
          },
          {
            label: t('termsThreshold'),
            value: terms.threshold ? formatMoney({ value: terms.threshold, asset: 'USDC' }) : t('notSet'),
            unset: terms.threshold === null,
          },
          venue.state === 'read'
            ? {
                label: t('termsVenue'),
                value: `${formatMoney({ value: venue.usdc, asset: 'USDC' })}${venue.test ? ' TEST' : ''}`,
                note: t('termsVenueAsOf', { at: new Date(venue.asOf).toLocaleString() }),
              }
            : {
                label: t('termsVenue'),
                value: venue.state === 'unreadable' ? t('termsVenueUnreadable') : t('termsVenueNone'),
                unset: true,
              },
        ]}
      />
    </section>
  );
}
