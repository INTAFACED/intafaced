import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Panel } from '../../shared/ui';
import { Details, Read, type ActionControls } from './common';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyPaths, formatDay, groupByPath, type AcademyPath, type LessonSummary, type Tracking } from './academy-lms';
import { useAcademyTracking } from './academy-tracking';
import { DisabledWithReason, pathLabel } from './AcademyLmsParts';
import { usePreferences } from '../../shared/preferences';

const enrolment = z.object({ userId: z.string().uuid(), pathSlug: z.string(), enrolledAt: z.string().datetime({ offset: true }) });
const badge = z.object({
  userId: z.string().uuid(),
  isAmbassador: z.boolean(),
  status: z.enum(['active', 'frozen']).nullable(),
});
const payQuote = z.object({ status: z.literal('refuse'), payable: z.literal(false), message: z.string(), code: z.string() });

/** Programme depth from real answers: path enrolment, prerequisites, grants, ambassador status and residency pay state. */
export function AcademyProgrammeOverview({ action }: { action: ActionControls }) {
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

function PathProgrammes({ lessons, action }: { lessons: readonly LessonSummary[]; action: ActionControls }) {
  const api = useApi();
  const { userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const groups = groupByPath(lessons);
  const stage = (path: AcademyPath) =>
    action.stage({
      title: t('enrolTitle'),
      confirm: t('enrolConfirm'),
      success: t('enrolDone'),
      content: (
        <p>
          <Copy k="enrolBody" params={{ path: pathLabel(t, path) }} />
        </p>
      ),
      run: () =>
        api.mutate(
          'academy',
          'enrollCertPath',
          { pathSlug: path },
          enrolment.refine((r) => r.userId === userId && r.pathSlug === path),
        ),
    });
  return (
    <Panel title={t('programmesTitle')}>
      <div className="academy-lms-stack">
        <p className="muted">
          <Copy k="programmesIntro" />
        </p>
        <div className="academy-lms-grid">
          {academyPaths.map((path) => {
            const group = groups.find((g) => g.path === path);
            return (
              <article key={path} className="academy-lms-card">
                <h3>{pathLabel(t, path)}</h3>
                <div className="academy-lms-meta">
                  <span>
                    <Copy k="lessonCount" params={{ count: group?.lessons.length ?? 0 }} />
                  </span>
                </div>
                <p className="muted">
                  <Copy k="prerequisitesNone" />
                </p>
                <p className="muted">
                  <Copy k="enrolmentUnread" />
                </p>
                <div className="academy-learning-actions">
                  <Button disabled={action.disabled || !userId} onClick={() => stage(path)}>
                    <Copy k="enrolButton" />
                  </Button>
                </div>
                <DisabledWithReason id={`academy-leave-${path}`} label={t('leaveButton')} reason={t('leaveReason')} />
              </article>
            );
          })}
        </div>
      </div>
    </Panel>
  );
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
                <strong lang="und">{tracking.definitions.find((d) => d.id === grant.certId)?.title ?? grant.certId}</strong>
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
