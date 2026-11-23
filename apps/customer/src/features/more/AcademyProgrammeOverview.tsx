import { z } from 'zod';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import type { Resource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import type { ActionControls } from './common';
import { presentActionFailure } from './action-state';
import { academyLmsCopy as copy } from './academy-lms-copy';
import {
  academyPaths,
  formatDay,
  groupByPath,
  isAcademyPath,
  type AcademyPath,
  type LessonSummary,
  type PathSummary,
  type Tracking,
} from './academy-lms';
import {
  academyRefusalKey,
  academyRefusalText,
  enrolReceipt,
  type Enrolment,
  leaveReceipt,
  newLeaveId,
  readEnrolments,
  settleByReading,
} from './academy-flows';
import { useAcademyTracking } from './academy-tracking';
import { ACADEMY_ENROLL_CERT_PATH } from '@intafaced/contracts/academy-learner-procedures';
import { pathLabel } from './academy-labels';
import { AcademyRefusal } from './academy-refusal';
import { KitGuardedButton } from './academy-guarded';
import { KitDetails } from './volt-action';
import { KitRead, Section, Waiting } from './volt-parts';
import { usePreferences } from '../../shared/preferences';
import { ACADEMY_RESIDENCY_PAY_QUOTE } from '@intafaced/contracts/academy-residency-pay-quote-procedures';
import { callAs } from '../../shared/api';
import { ACADEMY_AMBASSADOR_BADGE } from '@intafaced/contracts/academy-ambassador-badge-procedures';

const badge = z.object({
  userId: z.string().guid(),
  isAmbassador: z.boolean(),
  status: z.enum(['active', 'frozen']).nullable(),
});

/** Programme depth from real answers, drawn with the kit: path enrolment, prerequisites, grants, ambassador status and residency pay state. */
export function AcademyProgrammeOverview({ action }: { action: ProgrammeAction }) {
  const overview = useAcademyTracking();
  return (
    <>
      <KitRead resource={overview.resource} retry={overview.reload}>
        {(data) => (
          <>
            <PathProgrammes lessons={data.lessons} action={action} />
            <Grants tracking={data.tracking} />
          </>
        )}
      </KitRead>
      <AmbassadorStatus />
    </>
  );
}

/** What an enrolment card may do, and why not. The reason is the one the person can act on first. */
export function programmeGuards(input: {
  signedIn: boolean;
  enrolments: 'loading' | 'failed' | 'ready';
  enrolled: boolean;
  busy: ProgrammeBusy;
}): { enrol: GuardReason | null; leave: GuardReason | null } {
  const common: GuardReason | null = !input.signedIn
    ? 'signInReason'
    : input.enrolments === 'loading'
      ? 'enrolmentsLoadingReason'
      : input.enrolments === 'failed'
        ? 'enrolmentsUnreadableReason'
        : null;
  const busy: GuardReason | null =
    input.busy === 'inflight' ? 'actionInFlightReason' : input.busy === 'unconfirmed' ? 'actionUnconfirmedReason' : null;
  return {
    enrol: common ?? (input.enrolled ? 'enrolReasonEnrolled' : busy),
    leave: common ?? (input.enrolled ? busy : 'refEnrollmentNotFound'),
  };
}
/** Why the shared Academy action is not free: this page's own request is in flight, or an earlier one was never confirmed. */
export type ProgrammeBusy = 'inflight' | 'unconfirmed' | null;
/** The shared Academy action, with the two facts that tell its busy states apart when the hook offers them. */
export type ProgrammeAction = ActionControls & { busy?: boolean; snapshot?: { status: string; known?: unknown } };
export function busyOf(action: ProgrammeAction): ProgrammeBusy {
  if (action.busy) return 'inflight';
  if (action.snapshot && (action.snapshot.status !== 'empty' || action.snapshot.known)) return 'unconfirmed';
  return action.disabled ? 'inflight' : null;
}
type GuardReason =
  | 'signInReason'
  | 'enrolmentsLoadingReason'
  | 'enrolmentsUnreadableReason'
  | 'enrolReasonEnrolled'
  | 'actionInFlightReason'
  | 'actionUnconfirmedReason'
  | 'refEnrollmentNotFound';

const unrecorded = () => ({
  ok: false as const,
  reason: 'aborted' as const,
  code: 'academy.not_recorded',
  message: copy.t('writeNotRecorded'),
});
const changed = () => ({
  ok: false as const,
  reason: 'aborted' as const,
  code: 'academy.original_changed',
  message: 'The original Academy request remains unresolved.',
});
/** Typed Academy refusals reach the shared action panel in plain words, in the language the person reads. */
function worded<T extends Extract<ApiResult<unknown>, { ok: false }>>(result: T): T {
  const key = academyRefusalKey(result);
  if (!key) return result;
  return presentActionFailure(result, (locale) => {
    const presented = copy.forLocale(locale);
    return { message: academyRefusalText(result, presented.t) ?? result.message, language: presented.languageFor(key) };
  });
}

function PathProgrammes({ lessons, action }: { lessons: readonly LessonSummary[]; action: ProgrammeAction }) {
  const api = useApi();
  const { userId } = useSession();
  const groups = groupByPath(lessons);
  const enrolments = useResource((signal) => readEnrolments(api, userId, signal), `enrolments:${userId}`);
  const reloadEnrolments = enrolments.reload;
  const enrolStage = (path: AcademyPath) =>
    action.stage({
      title: () => copy.t('enrolTitle'),
      confirm: () => copy.t('enrolConfirm'),
      success: () => copy.t('enrolDone'),
      content: () => (
        <p>
          <copy.Copy k="enrolBody" params={{ path: pathLabel(copy.t, path) }} />
        </p>
      ),
      run: async (canDispatch) => {
        if (!canDispatch()) return changed();
        const sent = await api.call(
          ACADEMY_ENROLL_CERT_PATH,
          { pathSlug: path },
          { accept: (r) => enrolReceipt(userId, path).safeParse(r).success },
        );
        const settled = await settleByReading(
          sent,
          () => readEnrolments(api, userId),
          (now) => now.some((row) => row.pathSlug === path),
          unrecorded,
        );
        if (!settled.ok) reloadEnrolments();
        return settled.ok ? settled : worded(settled);
      },
      done: reloadEnrolments,
    });
  const leaveStage = (path: AcademyPath) => {
    // One reference for this decision: the service answers a repeat of it with the first leave, so a resend cannot leave twice.
    const clientRequestId = newLeaveId();
    action.stage({
      title: () => copy.t('leaveTitle'),
      confirm: () => copy.t('leaveConfirm'),
      success: () => copy.t('leaveDone'),
      content: () => (
        <p>
          <copy.Copy k="leaveBody" params={{ path: pathLabel(copy.t, path) }} />
        </p>
      ),
      run: async (canDispatch) => {
        if (!canDispatch()) return changed();
        const sent = await api.mutate('academy', 'leaveCertPath', { pathSlug: path, clientRequestId }, leaveReceipt(userId, path));
        const settled = await settleByReading(
          sent,
          () => readEnrolments(api, userId),
          (now) => !now.some((row) => row.pathSlug === path),
          unrecorded,
        );
        if (!settled.ok) reloadEnrolments();
        return settled.ok ? settled : worded(settled);
      },
      reference: clientRequestId,
      done: reloadEnrolments,
    });
  };
  return (
    <PathProgrammesView
      enrolments={enrolments.resource}
      reload={enrolments.reload}
      groups={groups}
      signedIn={Boolean(userId)}
      busy={busyOf(action)}
      onEnrol={enrolStage}
      onLeave={leaveStage}
    />
  );
}

/** Enrolments read back from Academy, then one card per programme whose buttons state why they are off. Pure: state arrives as props. */
export function PathProgrammesView({
  enrolments,
  reload,
  groups,
  signedIn,
  busy,
  onEnrol,
  onLeave,
}: {
  enrolments: Resource<Enrolment[]>;
  reload: () => void;
  groups: readonly PathSummary[];
  signedIn: boolean;
  busy: ProgrammeBusy;
  onEnrol: (path: AcademyPath) => void;
  onLeave: (path: AcademyPath) => void;
}) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  const rows = enrolments.status === 'ready' ? enrolments.data : [];
  return (
    <>
      <Section title={t('enrolmentsTitle')}>
        <div className="lt-stack">
          {enrolments.status === 'loading' && <Waiting />}
          {enrolments.status === 'failed' && <AcademyRefusal failure={enrolments.failure} retry={reload} />}
          {enrolments.status === 'ready' &&
            (rows.length === 0 ? (
              <p role="status">
                <Copy k="enrolmentsNone" />
              </p>
            ) : (
              <>
                <p role="status">
                  <Copy k="enrolmentsSummary" params={{ enrolled: rows.length, total: academyPaths.length }} />
                </p>
                <ul className="lt-stack" aria-label={t('enrolmentsTitle')}>
                  {rows.map((row, index) => (
                    <li key={row.pathSlug} className="lt-actions">
                      <span>{index + 1}</span>
                      <div className="lt-stack">
                        <strong lang={isAcademyPath(row.pathSlug) ? undefined : 'zxx'}>
                          {isAcademyPath(row.pathSlug) ? pathLabel(t, row.pathSlug) : row.pathSlug}
                        </strong>
                        <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
                          <time dateTime={row.enrolledAt}>
                            <Copy k="enrolledSince" params={{ date: formatDay(row.enrolledAt, language) }} />
                          </time>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ))}
        </div>
      </Section>
      <Section title={t('programmesTitle')}>
        <div className="lt-stack">
          <p className="lt-hint">
            <Copy k="programmesIntro" />
          </p>
          <div className="lt-stack">
            {academyPaths.map((path) => {
              const group = groups.find((g) => g.path === path);
              const enrolled = rows.find((row) => row.pathSlug === path);
              const guards = programmeGuards({
                signedIn,
                enrolments: enrolments.status,
                enrolled: Boolean(enrolled),
                busy,
              });
              return (
                <article key={path} className="lt-stack">
                  <h3>{pathLabel(t, path)}</h3>
                  <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
                    <span>
                      <Copy k="lessonCount" params={{ count: group?.lessons.length ?? 0 }} />
                    </span>
                    {enrolments.status === 'ready' && (
                      <span className="lt-chip" data-status={enrolled ? 'recorded' : 'open'}>
                        <span className="lt-chip-mark" aria-hidden="true" />
                        {enrolled ? (
                          <Copy k="enrolledSince" params={{ date: formatDay(enrolled.enrolledAt, language) }} />
                        ) : (
                          <Copy k="notEnrolled" />
                        )}
                      </span>
                    )}
                  </div>
                  <p className="lt-hint">
                    <Copy k="prerequisitesChecked" />
                  </p>
                  <div className="lt-actions">
                    <KitGuardedButton
                      reasonId={`academy-enrol-${path}`}
                      reason={guards.enrol && t(guards.enrol)}
                      onClick={() => onEnrol(path)}
                    >
                      <Copy k="enrolButton" />
                    </KitGuardedButton>
                    <KitGuardedButton
                      variant="secondary"
                      reasonId={`academy-leave-${path}`}
                      reason={guards.leave && t(guards.leave)}
                      onClick={() => onLeave(path)}
                    >
                      <Copy k="leaveButton" />
                    </KitGuardedButton>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </Section>
    </>
  );
}

/** A grant's name: its certificate's title, or for a programme certificate (AC-programmes-01) that word and its address. */
function grantTitle(t: (typeof copy)['t'], tracking: Tracking, certId: string): string {
  const programme = /^programme:(.+)$/.exec(certId)?.[1];
  if (programme) return `${t('programmeCertTitle')} · ${programme}`;
  return tracking.definitions.find((d) => d.id === certId)?.title ?? certId;
}

function Grants({ tracking }: { tracking: Tracking }) {
  const { t, Copy } = copy.useCopy();
  const { language } = usePreferences();
  return (
    <Section title={t('grantsTitle')}>
      <div className="lt-stack">
        {tracking.grants.length === 0 ? (
          <p>
            <Copy k="grantsEmpty" />
          </p>
        ) : (
          <ul className="lt-stack">
            {tracking.grants.map((grant, index) => (
              <li key={grant.idempotencyKey} className="lt-actions">
                <span>{index + 1}</span>
                <strong lang="und">{grantTitle(t, tracking, grant.certId)}</strong>
                <time dateTime={grant.grantedAt}>{formatDay(grant.grantedAt, language)}</time>
              </li>
            ))}
          </ul>
        )}
        <p className="lt-hint">
          <Copy k="grantsBoundary" />
        </p>
      </div>
    </Section>
  );
}

function AmbassadorStatus() {
  const api = useApi();
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const status = useResource(
    (signal) =>
      userId
        ? callAs(
            api,
            ACADEMY_AMBASSADOR_BADGE,
            { userId },
            badge.refine((b) => b.userId === userId),
            { signal },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `ambassador:${userId}`,
  );
  const pay = useResource((signal) => api.call(ACADEMY_RESIDENCY_PAY_QUOTE, undefined, { signal }), `residency-pay:${userId}`);
  return (
    <Section title={t('ambassadorTitle')}>
      <div className="lt-stack">
        <KitRead resource={status.resource} retry={status.reload}>
          {(b) =>
            b && (
              <KitDetails
                items={[
                  [
                    t('ambassadorStatus'),
                    b.isAmbassador ? (b.status === 'frozen' ? t('ambassadorFrozen') : t('ambassadorActive')) : t('ambassadorNone'),
                  ],
                ]}
              />
            )
          }
        </KitRead>
        <KitRead resource={pay.resource} retry={pay.reload}>
          {(quote) => (
            <KitDetails
              items={[
                [t('residencyPay'), t('residencyNotPayable')],
                [t('residencyPayReason'), <span lang="und">{quote.message}</span>],
              ]}
            />
          )}
        </KitRead>
        <p className="lt-hint">
          <Copy k="ambassadorBoundary" />
        </p>
      </div>
    </Section>
  );
}
