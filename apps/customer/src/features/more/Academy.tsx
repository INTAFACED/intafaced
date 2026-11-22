import { copy as moreCopy, t as copyText, Text } from './copy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { Button, Panel, Tabs } from '../../shared/ui';
import { Details, Read, Select, presentActionFailure } from './common';
import { useAcademyAction, type AcademyAction } from './academy-action';
import { AcademyGrantRecords } from './AcademyGrantRecords';
import { AcademyRooms } from './AcademyRooms';
import { AcademyProgrammes } from './AcademyProgrammes';
import { AcademyVideos } from './AcademyVideos';
import { AcademyRefusal } from './AcademyLmsParts';
import { AcademyPublic } from './AcademyPublic';
import { CertificateShelf } from './AcademyCertificates';
import { CertificateVerifyRoom } from './certificate-verify/CertificateVerifyRoom';
import { replyAccepted } from '@intafaced/contracts/procedure';
import {
  ACADEMY_CERT_DEFINITIONS,
  ACADEMY_CERT_PROGRESS,
  ACADEMY_ENROLL_CERT_PATH,
  ACADEMY_GRANT_CERT,
  academyCertGrantSchema,
  type AcademyCertGrant,
} from '@intafaced/contracts/academy-learner-procedures';
import { AcademyLearning, definitionsHold, progressFits, lessonHref, selectedCertificate, rememberCertificate } from './AcademyLearning';
import { academyLearningCopy } from './academy-learning-copy';
import { AcademyCoursePage, AcademyHub } from './AcademyHub';
import { AcademyAssignmentRoom } from './academy-assignment/AcademyAssignmentRoom';
import { AcademyProgrammePage } from './AcademyCourseProgrammes';
import { AcademyDiscussionCourses, AcademyDiscussionPage, AcademyDiscussionThread } from './AcademyDiscussion';
import { AcademyCourseConversation, AcademyCourseInbox, AcademyCourseMessagesLink } from './AcademyCourseMessages';
import { AcademyAccessGrants, AcademyMyLearning } from './AcademyMyLearning';
import { AcademyCourseProgress, AcademyPlanner } from './AcademyProgressPage';
import { AcademyCourseOutline } from './AcademyCourseOutline';
import { academySectionRedirect, academyTabHref, academyTabs, type AcademyRoute } from './academy-lms';
import { navigate } from '../../app/location';

/** `/academy` and everything under it. An old `?section=` link is replaced by the tab's own address before anything reads. */
export function AcademyRoom({
  pathname,
  search,
  route,
  slug,
  initialPath,
}: {
  pathname: string;
  search: string;
  route: AcademyRoute;
  slug?: string;
  initialPath?: string;
}) {
  const redirect = academySectionRedirect(pathname, search);
  useEffect(() => {
    if (redirect) navigate(redirect, true);
  }, [redirect]);
  const { userId } = useSession();
  if (redirect) return null;
  // A shared certificate link opens the same public check for everyone, signed in or not.
  if (route.kind === 'verify') return <CertificateVerifyRoom code={route.code} />;
  // A visitor with no account gets the signed-out Academy.
  if (!userId) return <AcademyPublic route={route} />;
  return <Academy route={route} slug={route.kind === 'reader' ? route.slug : slug} initialPath={initialPath} />;
}

function Academy({ route, slug, initialPath }: { route: AcademyRoute; slug?: string; initialPath?: string }) {
  const { userId } = useSession(),
    action = useAcademyAction();
  // A finished quiz or a watched video can meet an item's course rule: the outline beside it reads itself again.
  const [progressMade, setProgressMade] = useState(0);
  // Each tab is its own address: a click pushes history, so the back button returns to the previous tab.
  const tab =
    route.kind === 'tab'
      ? route.tab
      : route.kind === 'reader' || route.kind === 'course' || route.kind === 'assignment'
        ? 'Learning'
        : route.kind === 'programme'
          ? 'Programmes'
          : route.kind === 'discussion' || route.kind === 'messages'
            ? 'Rooms'
            : '';
  const [selection, setSelection] = useState({ owner: userId, id: selectedCertificate(userId) });
  const selected = selection.owner === userId ? selection.id : selectedCertificate(userId);
  useEffect(() => {
    rememberCertificate(userId, selected);
  }, [userId, selected]);
  function chooseCertificate(id: string) {
    action.retire();
    rememberCertificate(userId, id);
    setSelection({ owner: userId, id });
  }
  // An assignment is one task on the flow template: it draws its own title row and the Academy's tabs.
  if (route.kind === 'assignment') return <AcademyAssignmentRoom key={route.itemId} slug={route.slug ?? ''} itemId={route.itemId ?? ''} />;
  return (
    <div className="more-grid">
      <Tabs
        items={academyTabs.map(([name]) => name)}
        labels={{
          Learning: copyText('academy.learning'),
          Certificates: copyText('academy.certificates'),
          Rooms: copyText('academy.rooms'),
          Videos: copyText('academy.videos'),
          Programmes: copyText('academy.programmes'),
        }}
        value={tab}
        onChange={(next) => {
          action.retire();
          const target = academyTabs.find(([name]) => name === next);
          // The open tab is already this address: a second push would make Back seem to do nothing.
          if (target && (next !== tab || route.kind !== 'tab')) navigate(academyTabHref(target[0]));
        }}
        label={copyText('academy.academy.sections')}
      />
      {route.kind === 'tab' && route.hub && <AcademyHub />}
      {route.kind === 'course' ? (
        <AcademyCoursePage slug={route.slug} signedIn />
      ) : route.kind === 'discussion' ? (
        route.postId ? (
          <AcademyDiscussionThread key={route.postId} courseSlug={route.courseSlug} postId={route.postId} />
        ) : (
          <AcademyDiscussionPage key={route.courseSlug} courseSlug={route.courseSlug} />
        )
      ) : route.kind === 'messages' ? (
        route.conversationId ? (
          <AcademyCourseConversation key={route.conversationId} conversationId={route.conversationId} />
        ) : (
          <AcademyCourseInbox />
        )
      ) : route.kind === 'programme' ? (
        <AcademyProgrammePage key={route.slug} slug={route.slug} />
      ) : route.kind === 'progress' ? (
        <AcademyProgress action={action} />
      ) : tab === 'Learning' ? (
        <>
          {!slug && <AcademyMyLearning />}
          {slug && <AcademyCourseOutline key={slug} itemSlug={slug} refresh={action.result} progress={progressMade} />}
          <AcademyLearning
            slug={slug}
            initialPath={initialPath}
            certId={selected}
            chooseCertificate={chooseCertificate}
            action={action}
            onProgress={() => setProgressMade((n) => n + 1)}
          />
        </>
      ) : tab === 'Certificates' ? (
        <Certificates selected={selected} setSelected={chooseCertificate} action={action} />
      ) : tab === 'Rooms' ? (
        <>
          <AcademyDiscussionCourses />
          <AcademyCourseMessagesLink />
          <AcademyRooms action={action} />
        </>
      ) : tab === 'Videos' ? (
        <AcademyVideos />
      ) : (
        <AcademyProgrammes action={action} />
      )}
      {action.feedback}
      {action.dialog}
    </div>
  );
}
/** The grant this screen asked for: this account's, for the certificate chosen, under its one grant key. */
const grantIsMine = (userId: string | null | undefined, certId: string) => (r: AcademyCertGrant) =>
  r.grant.userId === userId && r.grant.certId === certId && r.grant.idempotencyKey === `cert:${userId}:${certId}`;
function Certificates({ action, selected, setSelected }: { action: AcademyAction; selected: string; setSelected: (id: string) => void }) {
  const api = useApi(),
    { userId } = useSession();
  const [enrolPath, setEnrolPath] = useState('foundations');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const context = useRef({ userId, selected, enrolPath });
  context.current = { userId, selected, enrolPath };
  const unchanged = (expected: typeof context.current) =>
    mounted.current &&
    action.isCurrent() &&
    api.canWrite() &&
    context.current.userId === expected.userId &&
    context.current.selected === expected.selected &&
    context.current.enrolPath === expected.enrolPath;
  const changed = () =>
    presentActionFailure(
      { ok: false as const, reason: 'aborted' as const, message: copyText('common.the.account.or.pending.request.changed.review') },
      (locale) => {
        const presented = moreCopy.forLocale(locale);
        return {
          message: presented.t('common.the.account.or.pending.request.changed.review'),
          language: presented.languageFor('common.the.account.or.pending.request.changed.review'),
        };
      },
    );
  const receipt = action.result?.ok
    ? academyCertGrantSchema
        .refine((r) => replyAccepted(ACADEMY_GRANT_CERT, r) && grantIsMine(userId, selected)(r))
        .safeParse(action.result.data)
    : null;
  const definitions = useResource(
    (signal) => api.call(ACADEMY_CERT_DEFINITIONS, undefined, { signal, accept: definitionsHold }),
    `cert-defs:${userId}`,
  );
  const selectedDefinition = definitions.resource.status === 'ready' ? definitions.resource.data.find((c) => c.id === selected) : undefined;
  const currentDefinition = useRef<string | null>(null);
  currentDefinition.current = selectedDefinition ? JSON.stringify(selectedDefinition.requiredItemSlugs) : null;
  useLayoutEffect(() => {
    action.retire();
  }, [selected, currentDefinition.current]);
  const detail = useResource(
    (signal) =>
      selectedDefinition
        ? api.call(
            ACADEMY_CERT_PROGRESS,
            { certId: selected },
            {
              signal,
              accept: progressFits(userId, selected, selectedDefinition.requiredItemSlugs),
            },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `cert-progress:${userId}:${selected}:${currentDefinition.current ?? ''}`,
  );
  return (
    <div className="academy-grant-certificates">
      <CertificateShelf />
      <AcademyGrantRecords
        action={action}
        titles={new Map(definitions.resource.status === 'ready' ? definitions.resource.data.map((row) => [row.id, row.title]) : [])}
      />
      <div className="more-columns">
        <Panel title={copyText('academy.certificate.paths')}>
          <Select
            label={copyText('academy.path.to.enrol.in')}
            value={enrolPath}
            onChange={(next) => {
              action.retire();
              setEnrolPath(next);
            }}
            options={['foundations', 'markets', 'builder', 'sovereign']}
          />
          <Button
            disabled={action.disabled}
            onClick={() => {
              const expected = { ...context.current };
              action.stage({
                title: () => copyText('academy.review.path.enrolment'),
                confirm: () => copyText('academy.enrol.in.path'),
                success: () => copyText('academy.enrolment.recorded'),
                content: () => (
                  <p>
                    <Text k="academy.enrol.in" />
                    <span lang="zxx">{expected.enrolPath}</span>
                    <Text k="academy.for.this.account" />
                  </p>
                ),
                run: async (canDispatch) => {
                  if (!canDispatch() || !unchanged(expected)) return changed();
                  return api.call(
                    ACADEMY_ENROLL_CERT_PATH,
                    { pathSlug: expected.enrolPath },
                    { accept: (r) => r.userId === expected.userId && r.pathSlug === expected.enrolPath },
                  );
                },
                done: () => {
                  if (unchanged(expected)) detail.reload();
                },
              });
            }}
          >
            <Text k="academy.review.enrolment" />
          </Button>
          <Read resource={definitions.resource} retry={definitions.reload} empty={copyText('academy.no.certificate.paths.are.published')}>
            {(rows) => (
              <div className="more-grid">
                {rows.map((c) => (
                  <article key={c.id}>
                    <h3 lang="und">{c.title}</h3>
                    <p>
                      {c.requiredItemSlugs.length}
                      <Text k="academy.required.learning.items" />
                    </p>
                    <Button variant="secondary" onClick={() => setSelected(c.id)}>
                      <Text k="academy.open" />
                      {c.title}
                    </Button>
                  </article>
                ))}
              </div>
            )}
          </Read>
        </Panel>
        <Panel title={copyText('academy.your.progress')}>
          <Read resource={detail.resource} retry={detail.reload} empty={copyText('academy.choose.a.certificate.path')}>
            {(p) =>
              p && selectedDefinition ? (
                <>
                  <h2 lang="und">{p.title}</h2>
                  <Details
                    items={[
                      [
                        copyText('academy.completed'),
                        copyText('common.progress.count', { completed: p.completedCount, required: p.requiredCount }),
                      ],
                      [copyText('academy.ratio'), p.ratio],
                      [copyText('academy.granted'), copyText(p.granted ? 'common.yes' : 'common.no')],
                    ]}
                  />
                  {p.missingItemSlugs[0] && (
                    <a className="academy-learning-link" href={lessonHref(p.missingItemSlugs[0], selected)}>
                      <academyLearningCopy.Copy k="readNext" />
                    </a>
                  )}
                  <ul>
                    {p.missingItemSlugs.map((s) => (
                      <li key={s}>
                        <a className="text-link" href={lessonHref(s, selected)} lang="zxx">
                          {s}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <Button
                    disabled={action.disabled || !selectedDefinition || (!p.complete && !p.granted)}
                    onClick={() => {
                      const expected = { ...context.current };
                      const required = [...selectedDefinition.requiredItemSlugs];
                      const definition = JSON.stringify(required);
                      const grantUnchanged = () => unchanged(expected) && currentDefinition.current === definition;
                      let dispatched = false;
                      action.stage({
                        title: () => copyText('academy.review.certification.grant'),
                        confirm: () =>
                          p.granted ? copyText('academy.recover.certification.award') : copyText('academy.request.certification'),
                        success: () => copyText('academy.certification.outcome.received.xp.delivery.is.shown'),
                        content: () => (
                          <p>
                            <Text k="academy.the.service.checks.completed.items.and.issues" />
                          </p>
                        ),
                        reference: `cert:${expected.userId}:${expected.selected}`,
                        grant: { certId: expected.selected, dispatched: () => dispatched },
                        run: async (canDispatch) => {
                          if (!canDispatch() || !grantUnchanged()) return changed();
                          const fresh = await api.call(
                            ACADEMY_CERT_PROGRESS,
                            { certId: expected.selected },
                            { accept: progressFits(expected.userId, expected.selected, required) },
                          );
                          if (!canDispatch() || !grantUnchanged()) return changed();
                          if (!fresh.ok) return fresh;
                          if (!fresh.data.complete && !fresh.data.granted)
                            return presentActionFailure(
                              { ok: false as const, reason: 'aborted' as const, message: academyLearningCopy.t('progressChanged') },
                              (locale) => {
                                const presented = academyLearningCopy.forLocale(locale);
                                return { message: presented.t('progressChanged'), language: presented.languageFor('progressChanged') };
                              },
                            );
                          dispatched = true;
                          return api.call(
                            ACADEMY_GRANT_CERT,
                            { certId: expected.selected },
                            { accept: grantIsMine(expected.userId, expected.selected) },
                          );
                        },
                        done: () => {
                          if (unchanged(expected)) detail.reload();
                        },
                      });
                    }}
                  >
                    {p.granted ? copyText('academy.recover.certification.award') : copyText('academy.request.certification')}
                  </Button>
                </>
              ) : null
            }
          </Read>
          {receipt?.success && (
            <section aria-label={copyText('academy.certification.receipt')}>
              <h3>
                <Text k="academy.certification.receipt" />
              </h3>
              <Details
                items={[
                  [copyText('academy.certification'), <code lang="zxx">{receipt.data.grant.certId}</code>],
                  [
                    copyText('academy.granted'),
                    <time lang="zxx" dateTime={receipt.data.grant.grantedAt}>
                      {receipt.data.grant.grantedAt}
                    </time>,
                  ],
                  [copyText('common.acting.as.account'), <code lang="zxx">{receipt.data.grant.userId}</code>],
                  [academyLearningCopy.t('grantReference'), <code lang="zxx">{receipt.data.grant.idempotencyKey}</code>],
                  [copyText('academy.already.granted'), copyText(receipt.data.alreadyGranted ? 'common.yes' : 'common.no')],
                  [
                    copyText('academy.xp.delivery'),
                    receipt.data.xp.emitted ? (
                      <academyLearningCopy.Copy k="xpPublished" params={{ xp: receipt.data.xp.xpDelta }} />
                    ) : (
                      <>
                        <academyLearningCopy.Copy k="xpNotPublished" />: <code lang="zxx">{receipt.data.xp.reason}</code>
                      </>
                    ),
                  ],
                  [
                    copyText('academy.perks'),
                    receipt.data.perks.status === 'real' ? (
                      copyText('academy.authoritative.identity.rank.perks.returned.academy.holds')
                    ) : (
                      <span lang="und">{receipt.data.perks.message}</span>
                    ),
                  ],
                ]}
              />
              <p className="muted">
                <academyLearningCopy.Copy k="xpPublishedBoundary" />
              </p>
            </section>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * `/academy/progress`: course progress, grades and the planner (AC-progress-02), then the access records and certificate
 * grant records (AC-order-01), on their own page outside the five tabs.
 */
function AcademyProgress({ action }: { action: AcademyAction }) {
  const api = useApi(),
    { userId } = useSession();
  const definitions = useResource(
    (signal) => api.call(ACADEMY_CERT_DEFINITIONS, undefined, { signal, accept: definitionsHold }),
    `cert-defs:${userId}`,
  );
  return (
    <div className="academy-grant-certificates">
      <AcademyCourseProgress />
      <AcademyPlanner />
      <AcademyAccessGrants />
      {/* Without the definitions the records still list, by reference; the failure says why the titles are missing. */}
      {definitions.resource.status === 'failed' && <AcademyRefusal failure={definitions.resource.failure} retry={definitions.reload} />}
      <AcademyGrantRecords
        action={action}
        titles={new Map(definitions.resource.status === 'ready' ? definitions.resource.data.map((row) => [row.id, row.title]) : [])}
      />
    </div>
  );
}
