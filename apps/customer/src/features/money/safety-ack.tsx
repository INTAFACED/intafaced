import { useRef, useState } from 'react';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import {
  SUPPORT_BEREAVEMENT_DATE_INVALID,
  SUPPORT_SAFETY_KEY_REUSED,
  supportSafetyAcknowledgementSchema,
  supportSafetyAcknowledgementsSchema,
  type SupportSafetyAcknowledgement,
  type SupportSafetyCaseKind,
} from '@intafaced/contracts/support-safety';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { useSession } from '../session/session';
import { safetyCopy } from './safety-copy';

/**
 * What the complaint and bereavement rooms share (BK-safe-03, J-bank-18 #5 #6): one request key per form, kept until a
 * send is answered, so a send whose answer was lost is sent again with the same key and shows the same acknowledgement;
 * the person's earlier acknowledgements; and the acknowledgement itself.
 */

type T = ReturnType<typeof safetyCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const newKey = (kind: SupportSafetyCaseKind) => `${kind}-${crypto.randomUUID()}`;

/** A refusal in the room's own words; the service's sentence is never shown. */
export function safetyRefusal(failure: Failed, t: T): Refusal {
  const reference = failure.code ?? failure.reason;
  if (failure.code === SUPPORT_SAFETY_KEY_REUSED)
    return { variant: 'refused', title: t('refusedTitle'), body: t('keyReusedBody'), reference };
  if (failure.code === SUPPORT_BEREAVEMENT_DATE_INVALID)
    return { variant: 'refused', title: t('refusedTitle'), body: t('dateInvalidBody'), reference };
  return {
    variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
    title: t('refusedTitle'),
    body: failure.reason === 'uncertain' || failure.reason === 'unreachable' ? t('uncertainBody') : t('otherBody'),
    reference,
  };
}

/** One send at a time, under the form's key; the key changes only after an answer that is not a lost one. */
export function useSafetySend<I extends object>(kind: SupportSafetyCaseKind, procedure: 'safety.complain' | 'safety.reportBereavement') {
  const { api } = useSession();
  const { t } = safetyCopy.useCopy();
  const key = useRef(newKey(kind));
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<SupportSafetyAcknowledgement | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  async function send(input: I): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    const out = await api.mutate('support', procedure, { ...input, requestKey: key.current }, supportSafetyAcknowledgementSchema);
    sending.current = false;
    setBusy(false);
    if (out.ok) {
      setSent(out.data);
      key.current = newKey(kind);
      return true;
    }
    setRefusal(safetyRefusal(out, t));
    return false;
  }
  return { send, busy, sent, refusal };
}

/** The person's own acknowledgements of one kind, newest first. */
export function useMyAcknowledgements(kind: SupportSafetyCaseKind, after: string | null) {
  const { api, userId } = useSession();
  return useResource(
    (signal) =>
      userId
        ? api.query('support', 'safety.mine', undefined, supportSafetyAcknowledgementsSchema, { signal })
        : Promise.resolve({ ok: true as const, data: { acknowledgements: [] } }),
    `safety-mine:${kind}:${userId ?? 'out'}:${after ?? ''}`,
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });

/** One acknowledgement: its reference, when, a complaint's deadline or "not set", and the request it made. */
export function Acknowledgement({ ack, title, live }: { ack: SupportSafetyAcknowledgement; title?: string; live?: boolean }) {
  const { t } = safetyCopy.useCopy();
  const deadline = ack.responseDeadline;
  return (
    <section
      aria-label={title ?? ack.reference}
      data-testid={`safety-ack-${ack.kind}`}
      data-reference={ack.reference}
      {...(live ? { role: 'status' } : {})}
    >
      {title ? <h2>{title}</h2> : null}
      <dl>
        <dt>{t('reference')}</dt>
        <dd data-testid="safety-ack-reference">{ack.reference}</dd>
        <dt>{t('acknowledgedAt')}</dt>
        <dd>
          <time dateTime={ack.acknowledgedAt}>{when(ack.acknowledgedAt)}</time>
        </dd>
        {deadline ? (
          <>
            <dt>{t('deadlineLabel')}</dt>
            <dd data-testid="safety-ack-deadline" data-status={deadline.status}>
              {deadline.status === 'set' ? (
                <>
                  {t('deadlineSet')} <time dateTime={deadline.dueAt}>{day(deadline.dueAt)}</time> (
                  {t('deadlineLimit', { days: deadline.limitDays })})
                </>
              ) : (
                <>
                  <strong>{t('deadlineNotSet')}</strong> {t('deadlineNotSetBody')}
                </>
              )}
            </dd>
          </>
        ) : null}
      </dl>
      <a href={`/support/tickets/${ack.ticketId}`}>{t('openRequest')}</a>
    </section>
  );
}

/** The room's state: signed out, or ready with any refusal of the last send shown above the form. */
export function safetyState(signedIn: boolean, refusal: Refusal | null, t: T, returnTo: string): RoomState {
  if (!signedIn)
    return {
      kind: 'refused',
      refusal: {
        variant: 'refused',
        title: t('signedOutTitle'),
        body: t('signedOutBody'),
        action: { label: t('signIn'), href: `/login?redirect=${encodeURIComponent(returnTo)}` },
      },
    };
  if (refusal) return { kind: 'ready', partial: { missing: refusal } };
  return { kind: 'ready' };
}

/** The list of earlier acknowledgements of one kind, or why it could not be read. */
export function EarlierAcknowledgements({
  kind,
  heading,
  none,
  resource,
}: {
  kind: SupportSafetyCaseKind;
  heading: string;
  none: string;
  resource: ReturnType<typeof useMyAcknowledgements>['resource'];
}) {
  const { t } = safetyCopy.useCopy();
  if (resource.status === 'loading') return null;
  if (resource.status === 'failed')
    return (
      <p role="alert">
        {t('readFailedTitle')}. {t('readFailedBody')}
      </p>
    );
  const mine = resource.data.acknowledgements.filter((a) => a.kind === kind);
  return (
    <section aria-label={heading} data-testid={`safety-earlier-${kind}`}>
      <h2>{heading}</h2>
      {mine.length === 0 ? <p>{none}</p> : mine.map((ack) => <Acknowledgement key={ack.id} ack={ack} />)}
    </section>
  );
}
