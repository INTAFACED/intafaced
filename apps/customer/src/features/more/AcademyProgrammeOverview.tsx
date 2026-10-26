import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import type { Resource } from '../../shared/resource';
import { Loading, Panel } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { Details, Read, presentActionFailure, type ActionControls } from './common';
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
import { AcademyRefusal, GuardedButton, pathLabel } from './AcademyLmsParts';
import { usePreferences } from '../../shared/preferences';

const badge = z.object({
  userId: z.string().guid(),
  isAmbassador: z.boolean(),
  status: z.enum(['active', 'frozen']).nullable(),
});
const payQuote = z.object({ status: z.literal('refuse'), payable: z.literal(false), message: z.string(), code: z.string() });

/** Programme depth from real answers: path enrolment, prerequisites, grants, ambassador status and residency pay state. */
export function AcademyProgrammeOverview({ action }: { action: ProgrammeAction }) {
  const overview = useAcademyTracking();
  return (
    <>
      <Read resource={overview.resource} retry={overview.reload}>
        {(data) => (
          <>
            <PathProgrammes lessons={data.lessons} action={action} />
            <Grants tracking={data.tracking} />
          </>
        )}
      </Read>
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
        const sent = await api.mutate('academy', 'enrollCertPath', { pathSlug: path }, enrolReceipt(userId, path));
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
      <Panel title={t('enrolmentsTitle')}>
        <div className="academy-lms-stack">
          {enrolments.status === 'loading' && <Loading />}
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
                <ul className="academy-lms-rows" aria-label={t('enrolmentsTitle')}>
                  {rows.map((row, index) => (
                    <li key={row.pathSlug}>
                      <span>{index + 1}</span>
                      <div>
                        <strong lang={isAcademyPath(row.pathSlug) ? undefined : 'zxx'}>
                          {isAcademyPath(row.pathSlug) ? pathLabel(t, row.pathSlug) : row.pathSlug}
                        </strong>
                        <div data-testid="academy-lms-meta" className="academy-lms-meta">
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
      </Panel>
      <Panel title={t('programmesTitle')}>
        <div className="academy-lms-stack">
          <p className="muted">
            <Copy k="programmesIntro" />
          </p>
          <div className="academy-lms-grid">
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
                <article key={path} className="academy-lms-card">
                  <h3>{pathLabel(t, path)}</h3>
                  <div data-testid="academy-lms-meta" className="academy-lms-meta">
                    <span>
                      <Copy k="lessonCount" params={{ count: group?.lessons.length ?? 0 }} />
                    </span>
                    {enrolments.status === 'ready' && (
                      <span className="academy-lms-chip" data-status={enrolled ? 'recorded' : 'open'}>
                        {enrolled ? (
                          <Copy k="enrolledSince" params={{ date: formatDay(enrolled.enrolledAt, language) }} />
                        ) : (
                          <Copy k="notEnrolled" />
                        )}
                      </span>
                    )}
                  </div>
                  <p className="muted">
                    <Copy k="prerequisitesChecked" />
                  </p>
                  <div className="academy-learning-actions">
                    <GuardedButton
                      reasonId={`academy-enrol-${path}`}
                      reason={guards.enrol && t(guards.enrol)}
                      onClick={() => onEnrol(path)}
                    >
                      <Copy k="enrolButton" />
                    </GuardedButton>
                    <GuardedButton
                      variant="secondary"
                      reasonId={`academy-leave-${path}`}
                      reason={guards.leave && t(guards.leave)}
                      onClick={() => onLeave(path)}
                    >
                      <Copy k="leaveButton" />
                    </GuardedButton>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </Panel>
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
    <Panel title={t('grantsTitle')}>
      <div className="academy-lms-stack">
        {tracking.grants.length === 0 ? (
          <p>
            <Copy k="grantsEmpty" />
          </p>
        ) : (
          <ul className="academy-lms-rows">
            {tracking.grants.map((grant, index) => (
              <li key={grant.idempotencyKey}>
                <span>{index + 1}</span>
                <strong lang="und">{grantTitle(t, tracking, grant.certId)}</strong>
                <time dateTime={grant.grantedAt}>{formatDay(grant.grantedAt, language)}</time>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          <Copy k="grantsBoundary" />
        </p>
      </div>
    </Panel>
  );
}

function AmbassadorStatus() {
  const api = useApi();
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const status = useResource(
    (signal) =>
      userId
        ? api.query(
            'academy',
            'ambassadorBadge',
            { userId },
            badge.refine((b) => b.userId === userId),
            { signal },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `ambassador:${userId}`,
  );
  const pay = useResource(
    (signal) => api.query('academy', 'residencyPayQuote', undefined, payQuote, { signal }),
    `residency-pay:${userId}`,
  );
  return (
    <Panel title={t('ambassadorTitle')}>
      <div className="academy-lms-stack">
        <Read resource={status.resource} retry={status.reload}>
          {(b) =>
            b && (
              <Details
                items={[
                  [
                    t('ambassadorStatus'),
                    b.isAmbassador ? (b.status === 'frozen' ? t('ambassadorFrozen') : t('ambassadorActive')) : t('ambassadorNone'),
                  ],
                ]}
              />
            )
          }
        </Read>
        <Read resource={pay.resource} retry={pay.reload}>
          {(quote) => (
            <Details
              items={[
                [t('residencyPay'), t('residencyNotPayable')],
                [t('residencyPayReason'), <span lang="und">{quote.message}</span>],
              ]}
            />
          )}
        </Read>
        <p className="muted">
          <Copy k="ambassadorBoundary" />
        </p>
      </div>
    </Panel>
  );
}
