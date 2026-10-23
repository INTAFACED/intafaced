import { useRef, useState } from 'react';
import type { z } from 'zod';
import {
  academyAuthoredCourseEnrolmentSchema,
  academyCourseEnrolmentSchema,
  type AcademyAuthoredCourseEnrolment,
  type AcademyEnrolmentClosedReason,
  type AcademyEnrolmentTrack,
} from '@intafaced/contracts/academy-catalogue';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { Button, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { useApi, useSession } from '../session/session';
import { leaveReceipt } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { formatDay } from './academy-lms';
import { AcademyRefusal, GuardedButton } from './AcademyLmsParts';

type Failure = Extract<ApiResult<never>, { ok: false }>;
type T = (typeof copy)['t'];

const CLOSED_KEYS = {
  unpublished: 'closedUnpublished',
  hidden: 'closedHidden',
  no_price: 'closedNoPrice',
  window_not_started: 'closedWindowNotStarted',
  window_ended: 'closedWindowEnded',
  full: 'closedFull',
  payments_off: 'closedPaymentsOff',
} as const satisfies Record<AcademyEnrolmentClosedReason, string>;
const TRACK_KEYS = { audit: 'trackAudit', certificate: 'trackCertificate' } as const satisfies Record<AcademyEnrolmentTrack, string>;

export const closedReasonText = (t: T, reason: AcademyEnrolmentClosedReason) => t(CLOSED_KEYS[reason]);

/**
 * Enrol now on the course page (AC-enrolment-01), signed in. The terms come from the service: tracks with their closed
 * reasons, the start date, seats only when a cap exists. One press sends one request and the button stays off until
 * the stored state has been read again, so the page shows what Academy recorded rather than what was asked.
 */
export function AcademyCourseEnrol({
  slug,
  source = 'path',
  onSettled,
}: {
  slug: string;
  /** A curriculum path, or a course staff made (AC-catalogue-03). */
  source?: 'path' | 'authored';
  /** Called once an enrol or leave has settled, so the page can read what it opens again. */
  onSettled?: () => void;
}) {
  const api = useApi();
  const { userId } = useSession();
  const authored = source === 'authored';
  const schema: z.ZodType<AcademyAuthoredCourseEnrolment> = authored ? academyAuthoredCourseEnrolmentSchema : academyCourseEnrolmentSchema;
  const terms = useResource(
    (signal) => api.query('academy', authored ? 'authoredCourseEnrolment' : 'courseEnrolment', { slug }, schema, { signal }),
    `course-enrolment:${source}:${slug}`,
  );
  const [sending, setSending] = useState(false);
  // A second press before React re-renders still finds the first one in flight: one press, one request.
  const inFlight = useRef(false);
  const [refusal, setRefusal] = useState<{ kind: 'enrol' | 'leave'; failure: Failure } | null>(null);
  const send = async (kind: 'enrol' | 'leave', request: () => Promise<ApiResult<unknown>>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(null);
    let settled = false;
    try {
      const sent = await request();
      if (!sent.ok) setRefusal({ kind, failure: sent });
      settled = sent.ok;
    } finally {
      inFlight.current = false;
      setSending(false);
      terms.reload();
      // Only a stored change changes what the page opens; a refusal keeps its reason on screen.
      if (settled) onSettled?.();
    }
  };
  const enrol = (track: AcademyEnrolmentTrack) =>
    send('enrol', () => api.mutate('academy', authored ? 'enrolAuthoredCourse' : 'enrolCourse', { slug, track }, schema));
  // The business key of this leave is the enrolment it ends: a resend after a lost reply is the same leave, never a second.
  const leave = (enrolledAt: string) =>
    send('leave', () =>
      authored
        ? api.mutate('academy', 'leaveAuthoredCourse', { slug, enrolledAt }, schema)
        : api.mutate(
            'academy',
            'leaveCertPath',
            { pathSlug: slug, clientRequestId: `leave:${slug}:${enrolledAt}` },
            leaveReceipt(userId, slug),
          ),
    );
  if (terms.resource.status === 'loading') return <Loading />;
  if (terms.resource.status === 'failed')
    return (
      <>
        {/* A refused enrolment keeps its own reason even when the read after it fails too. */}
        {refusal && <AcademyRefusal failure={refusal.failure} />}
        <AcademyRefusal failure={terms.resource.failure} retry={terms.reload} />
      </>
    );
  return <CourseEnrolView terms={terms.resource.data} sending={sending} refusal={refusal} onEnrol={enrol} onLeave={leave} />;
}

/** The enrol block as data says it. Pure: state arrives as props. */
export function CourseEnrolView({
  terms,
  sending,
  refusal,
  onEnrol,
  onLeave,
}: {
  terms: AcademyAuthoredCourseEnrolment;
  sending: boolean;
  refusal: { kind: 'enrol' | 'leave'; failure: Failure } | null;
  onEnrol: (track: AcademyEnrolmentTrack) => void;
  onLeave: (enrolledAt: string) => void;
}) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const openTracks = terms.tracks.filter((row) => row.closed === null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [picked, setPicked] = useState<AcademyEnrolmentTrack | null>(null);
  // A track that has closed since it was picked is no longer the choice; the first open one is.
  const chosen = openTracks.find((row) => row.track === picked)?.track ?? openTracks[0]?.track ?? null;
  const enrolled = terms.enrolment;
  const reason = terms.closed
    ? closedReasonText(t, terms.closed)
    : chosen === null
      ? t('enrolChooseTrack')
      : sending
        ? t('enrolSending')
        : null;
  return (
    <div className="academy-lms-stack" data-academy-enrol={terms.slug}>
      <dl className="academy-enrol-terms">
        <dt>
          <Copy k="enrolStart" />
        </dt>
        <dd>
          {terms.startsAt ? (
            <time dateTime={terms.startsAt}>
              <Copy k="enrolOpensOn" params={{ date: formatDay(terms.startsAt, language) }} />
            </time>
          ) : (
            <Copy k="enrolSelfPaced" />
          )}
        </dd>
        <dt>
          <Copy k="enrolSeats" />
        </dt>
        <dd>
          {terms.seatCap === null || terms.seatsRemaining === null ? (
            <Copy k="enrolSeatsNotSet" />
          ) : (
            <Copy k="enrolSeatsLeft" params={{ remaining: terms.seatsRemaining, cap: terms.seatCap }} />
          )}
        </dd>
      </dl>
      {enrolled ? (
        <>
          <p role="status">
            <time dateTime={enrolled.enrolledAt}>
              <Copy k="enrolledOnTrack" params={{ track: t(TRACK_KEYS[enrolled.track]), date: formatDay(enrolled.enrolledAt, language) }} />
            </time>
          </p>
          {terms.activationMail && <ServiceOffNotice code={terms.activationMail} action={t('enrolActivationMail')} role="status" />}
          {confirmingLeave ? (
            <div className="academy-lms-stack" role="group" aria-label={t('courseLeave')}>
              <p>
                <Copy k="courseLeaveNote" />
              </p>
              <GuardedButton
                reason={sending ? t('courseLeaving') : null}
                reasonId={`academy-leave-${terms.slug}-reason`}
                onClick={() => {
                  setConfirmingLeave(false);
                  onLeave(enrolled.enrolledAt);
                }}
              >
                <Copy k="courseLeaveConfirm" />
              </GuardedButton>
              <Button variant="secondary" onClick={() => setConfirmingLeave(false)}>
                <Copy k="courseLeaveKeep" />
              </Button>
            </div>
          ) : (
            <GuardedButton
              variant="secondary"
              reason={sending ? t('courseLeaving') : null}
              reasonId={`academy-leave-${terms.slug}-reason`}
              onClick={() => setConfirmingLeave(true)}
            >
              <Copy k="courseLeave" />
            </GuardedButton>
          )}
        </>
      ) : (
        <>
          {terms.closed && <p role="status">{closedReasonText(t, terms.closed)}</p>}
          <fieldset className="academy-enrol-tracks">
            <legend>
              <Copy k="enrolTracks" />
            </legend>
            {terms.tracks.map((row) => {
              const id = `academy-enrol-${terms.slug}-${row.track}`;
              return (
                <div key={row.track}>
                  <label htmlFor={id}>
                    <input
                      id={id}
                      type="radio"
                      name={`academy-enrol-${terms.slug}`}
                      value={row.track}
                      checked={chosen === row.track}
                      disabled={row.closed !== null || terms.closed !== null}
                      aria-describedby={row.closed ? `${id}-closed` : undefined}
                      onChange={() => setPicked(row.track)}
                    />{' '}
                    {t(TRACK_KEYS[row.track])}
                    {row.free && (
                      <span className="muted">
                        {' · '}
                        <Copy k="trackFree" />
                      </span>
                    )}
                  </label>
                  {row.closed && (
                    <small id={`${id}-closed`} className="muted">
                      {' '}
                      {closedReasonText(t, row.closed)}
                    </small>
                  )}
                </div>
              );
            })}
          </fieldset>
          <GuardedButton reason={reason} reasonId={`academy-enrol-${terms.slug}-reason`} onClick={() => chosen && onEnrol(chosen)}>
            <Copy k="enrolNow" />
          </GuardedButton>
        </>
      )}
      {/* A lost reply whose change was stored reads back as done: the stored state wins over the failed send. */}
      {refusal && (refusal.kind === 'enrol') === !enrolled && <AcademyRefusal failure={refusal.failure} />}
    </div>
  );
}
