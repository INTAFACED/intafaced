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
import { Button, Radio } from '@intafaced/ui/lit';
import { usePreferences } from '../../shared/preferences';
import { useApi, useSession } from '../session';
import { leaveReceipt } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { formatDay } from './academy-lms';
import { AcademyRefusal } from './academy-refusal';
import { KitGuardedButton as GuardedButton } from './academy-guarded';
import { ServiceOffNote as ServiceOffNotice } from './service-off-note';
import { Waiting } from './volt-parts';
import { ACADEMY_LEAVE_AUTHORED_COURSE } from '@intafaced/contracts/academy-leave-authored-course-procedures';
import { ACADEMY_AUTHORED_COURSE_ENROLMENT } from '@intafaced/contracts/academy-authored-course-enrolment-procedures';
import { ACADEMY_COURSE_ENROLMENT } from '@intafaced/contracts/academy-course-enrolment-procedures';
import { ACADEMY_ENROL_AUTHORED_COURSE } from '@intafaced/contracts/academy-enrol-authored-course-procedures';
import { ACADEMY_ENROL_COURSE } from '@intafaced/contracts/academy-enrol-course-procedures';

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
    (signal) =>
      authored
        ? api.call(ACADEMY_AUTHORED_COURSE_ENROLMENT, { slug }, { signal })
        : api.call(ACADEMY_COURSE_ENROLMENT, { slug }, { signal }),
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
    send('enrol', () =>
      authored ? api.call(ACADEMY_ENROL_AUTHORED_COURSE, { slug, track }) : api.call(ACADEMY_ENROL_COURSE, { slug, track }),
    );
  // The business key of this leave is the enrolment it ends: a resend after a lost reply is the same leave, never a second.
  const leave = (enrolledAt: string) =>
    send('leave', () =>
      authored
        ? api.call(ACADEMY_LEAVE_AUTHORED_COURSE, { slug, enrolledAt })
        : api.mutate(
            'academy',
            'leaveCertPath',
            { pathSlug: slug, clientRequestId: `leave:${slug}:${enrolledAt}` },
            leaveReceipt(userId, slug),
          ),
    );
  if (terms.resource.status === 'loading') return <Waiting />;
  if (terms.resource.status === 'failed')
    return (
      <>
        {/* A refused enrolment keeps its own reason even when the read after it fails too. */}
        {refusal && <AcademyRefusal failure={refusal.failure} />}
        <AcademyRefusal failure={terms.resource.failure} retry={terms.reload} />
      </>
    );
  return (
    <CourseEnrolView
      terms={terms.resource.data}
      sending={sending}
      refusal={refusal}
      onEnrol={enrol}
      onLeave={leave}
      selectClosed={authored}
    />
  );
}

/** The enrol block as data says it. Pure: state arrives as props. */
export function CourseEnrolView({
  terms,
  sending,
  refusal,
  onEnrol,
  onLeave,
  selectClosed = false,
}: {
  terms: AcademyAuthoredCourseEnrolment;
  sending: boolean;
  refusal: { kind: 'enrol' | 'leave'; failure: Failure } | null;
  onEnrol: (track: AcademyEnrolmentTrack) => void;
  onLeave: (enrolledAt: string) => void;
  /**
   * A course staff made (J-academy-07 #1): a track closed only because no price is set can still be chosen, and Enrol
   * then refuses with "price not set" beside it, so the refusal is seen where the person presses. A track closed for
   * any other reason (payments switched off, J-academy-11 #10) stays disabled with its reason.
   */
  selectClosed?: boolean;
}) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const openTracks = terms.tracks.filter((row) => row.closed === null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [picked, setPicked] = useState<AcademyEnrolmentTrack | null>(null);
  // A track that has closed since it was picked is no longer the choice; the first open one is.
  const choosable = (row: { closed: string | null }) => row.closed === null || (selectClosed && row.closed === 'no_price');
  const pickedClosed = selectClosed ? (terms.tracks.find((row) => row.track === picked && row.closed === 'no_price') ?? null) : null;
  const chosen = pickedClosed?.track ?? openTracks.find((row) => row.track === picked)?.track ?? openTracks[0]?.track ?? null;
  const enrolled = terms.enrolment;
  const reason = terms.closed
    ? closedReasonText(t, terms.closed)
    : chosen === null
      ? t('enrolChooseTrack')
      : pickedClosed
        ? t('enrolRefusedNoPrice')
        : sending
          ? t('enrolSending')
          : null;
  return (
    <div className="lt-stack" data-academy-enrol={terms.slug}>
      <dl className="lt-kv">
        <div>
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
        </div>
        <div>
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
        </div>
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
            <div className="lt-stack" role="group" aria-label={t('courseLeave')}>
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
              <Button tone="secondary" onClick={() => setConfirmingLeave(false)}>
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
          {/* A closed course says why once, next to the disabled Enrol now. */}
          <fieldset className="lt-stack">
            <legend>
              <Copy k="enrolTracks" />
            </legend>
            {terms.tracks.map((row) => {
              const id = `academy-enrol-${terms.slug}-${row.track}`;
              return (
                <div key={row.track}>
                  <Radio
                    id={id}
                    name={`academy-enrol-${terms.slug}`}
                    value={row.track}
                    checked={chosen === row.track}
                    disabled={!choosable(row) || terms.closed !== null}
                    aria-describedby={row.closed ? `${id}-closed` : undefined}
                    onSelect={() => setPicked(row.track)}
                  >
                    {t(TRACK_KEYS[row.track])}
                    {row.free && (
                      <span className="lt-hint">
                        {' · '}
                        <Copy k="trackFree" />
                      </span>
                    )}
                  </Radio>
                  {row.closed && (
                    <small id={`${id}-closed`} className="lt-hint">
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
