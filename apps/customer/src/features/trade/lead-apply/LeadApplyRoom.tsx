import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Field, Input } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { leadApplyCopy } from './lead-apply-copy';

/**
 * Apply to lead (CB-copy-12), on the flow template. The person's newest application is read from svc-trade
 * (`copy.myLeadApplication`); an application is sent with `copy.applyToLead`, one open application per person, and
 * the same submit again answers with the same application. Founders decide it in the console's Copy trading desk.
 */

// hand-declared-ok: svc-trade's copy procedures have no browser-safe schema in packages/contracts yet (the Copy room's api.ts declares its own the same way)
const mineSchema = z.object({
  applicationId: z.string(),
  state: z.enum(['submitted', 'approved', 'rejected']),
  displayName: z.string(),
  submittedAt: z.string(),
  reason: z.string().nullable(),
});
type Mine = z.infer<typeof mineSchema>;

type T = ReturnType<typeof leadApplyCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** svc-trade's code: the code that ends the message in square brackets, or the error cause. */
function codeOf(failure: Failed): string | undefined {
  return /\[([a-z_.]+)\]\s*$/.exec(failure.message ?? '')?.[1] ?? failure.code;
}

/** A refused application, in the room's own words: the service's sentence is never shown. */
function applyRefusal(failure: Failed, t: T): Refusal {
  const code = codeOf(failure);
  const reference = code ?? failure.reason;
  if (code === 'trade.copy_lead_application_open') return { variant: 'refused', title: t('openTitle'), body: t('openBody'), reference };
  if (code === 'trade.copy_lead_already_leading')
    return { variant: 'refused', title: t('leadingTitle'), body: t('leadingBody'), reference };
  if (code === 'trade.copy_lead_name_invalid') return { variant: 'refused', title: t('nameTitle'), body: t('nameBody'), reference };
  if (code === 'trade.copy_lead_reapply_wait_unset') return { variant: 'refused', title: t('waitTitle'), body: t('waitBody'), reference };
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
      userId
        ? api.query('trade', 'copy.myLeadApplication', undefined, mineSchema.nullable(), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `lead-apply:${userId ?? 'out'}`,
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [sent, setSent] = useState<Mine | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const nameId = useId();

  const current = sent ?? (mine.resource.status === 'ready' ? mine.resource.data : null);
  // After a rejection the wait before applying again is the platform's to set and is unset, so only a first application is offered.
  const canApply = !current;

  async function apply(e: FormEvent) {
    e.preventDefault();
    // One request per submit, and never a second while the first has no answer.
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    const out = await api.mutate('trade', 'copy.applyToLead', { displayName: name.trim() }, mineSchema);
    sending.current = false;
    setBusy(false);
    if (out.ok) setSent(out.data);
    else setRefusal(applyRefusal(out, t));
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
    // After a rejection, applying again waits on the platform's waiting period, which is not set: refused by name.
    if (current?.state === 'rejected')
      return {
        kind: 'ready',
        partial: {
          missing: { variant: 'refused', title: t('waitTitle'), body: t('waitBody'), reference: 'trade.copy_lead_reapply_wait_unset' },
        },
      };
    return { kind: 'ready' };
  }, [userId, mine.resource, refusal, current?.state, t]);

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      step={
        <div className="lead-apply">
          {sent ? <p role="status">{t('sent')}</p> : null}
          {!sent && current?.state === 'submitted' ? <p>{t('waiting', { name: current.displayName })}</p> : null}
          {current?.state === 'approved' ? (
            <p>
              {t('approved', { name: current.displayName })} <a href="/trade/copy">{t('openCopy')}</a>
            </p>
          ) : null}
          {current?.state === 'rejected' ? <p>{t('rejected', { name: current.displayName, reason: current.reason ?? '' })}</p> : null}
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
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summaryReview')}</p>
          <p>{t('summaryRecord')}</p>
        </div>
      }
    />
  );
}
