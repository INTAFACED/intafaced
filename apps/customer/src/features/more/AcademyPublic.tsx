import { useState } from 'react';
import { z } from 'zod';
import {
  ACADEMY_PUBLIC_CATALOGUE_SORTS,
  academyCurriculumSummarySchema,
  academyPublicItemSchema,
  academyPublicVideoSchema,
  type AcademyPublicCatalogueSort,
} from '@intafaced/contracts/academy-catalogue';
import { navigate } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Field, Loading, Panel, Tabs } from '../../shared/ui';
import { Select } from './common';
import './academy-public.css';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyTabHref, academyTabs, isAcademyPath, type AcademyRoute } from './academy-lms';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';
import { LessonBody } from './AcademyLearning';
import { VerifyPanel } from './AcademyCertificates';
import { AcademyCoursePage, AcademyCourseCards, AcademyHub } from './AcademyHub';

/**
 * The Academy for a visitor with no account (J-academy-01): the same five tabs at the same addresses, the published
 * catalogue with search and sort, and the reader. Nothing here reads or writes a learner record; the personal parts
 * say they need sign-in. Reads go to svc-academy's signed-out doors.
 */
const PAGE = 50;
const summary = academyCurriculumSummarySchema;
const item = academyPublicItemSchema;
const sorts = ACADEMY_PUBLIC_CATALOGUE_SORTS;
type Sort = AcademyPublicCatalogueSort;

function SignIn() {
  const { Copy } = copy.useCopy();
  const here = safeReturnTo(location.pathname + location.search);
  return (
    <a className="button button--primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
      <Copy k="publicSignIn" />
    </a>
  );
}

export function AcademyPublic({ route }: { route: AcademyRoute }) {
  const tab =
    route.kind === 'tab'
      ? route.tab
      : route.kind === 'reader' || route.kind === 'course' || route.kind === 'assignment'
        ? 'Learning'
        : route.kind === 'programme'
          ? 'Programmes'
          : '';
  const { t } = copy.useCopy();
  return (
    <div className="more-grid" data-academy-visitor="true">
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
          const target = academyTabs.find(([name]) => name === next);
          if (target && (next !== tab || route.kind !== 'tab')) navigate(academyTabHref(target[0]));
        }}
        label={copyText('academy.academy.sections')}
      />
      {route.kind === 'tab' && route.hub && <AcademyHub />}
      {route.kind === 'course' ? (
        <AcademyCoursePage slug={route.slug} signedIn={false} />
      ) : route.kind === 'assignment' ? (
        <Panel title={copyText('academy.learning')}>
          <EmptyState title={t('asgSignIn')} action={<SignIn />} />
        </Panel>
      ) : route.kind === 'reader' && route.slug ? (
        <PublicReader slug={route.slug} />
      ) : route.kind === 'progress' || tab === 'Certificates' ? (
        <PublicCertificates />
      ) : tab === 'Rooms' ? (
        <Panel title={copyText('academy.rooms')}>
          <EmptyState title={t('publicRoomsSignIn')} action={<SignIn />} />
        </Panel>
      ) : tab === 'Programmes' ? (
        <Panel title={copyText('academy.programmes')}>
          <EmptyState title={t('publicProgrammesSignIn')} action={<SignIn />} />
        </Panel>
      ) : tab === 'Videos' ? (
        <PublicVideos />
      ) : (
        <>
          <Panel title={t('publicCourses')}>
            <AcademyCourseCards />
          </Panel>
          <PublicCatalogue />
        </>
      )}
    </div>
  );
}

function PublicCatalogue() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recommended');
  const [limit, setLimit] = useState(PAGE);
  const q = query.trim();
  const list = useResource(
    (signal) => api.query('academy', 'publicCurriculum', { ...(q ? { q } : {}), sort, limit }, z.array(summary), { signal }),
    `public-curriculum:${q}:${sort}:${limit}`,
  );
  const sortLabels: Record<Sort, string> = {
    recommended: t('publicSortRecommended'),
    name_asc: t('publicSortNameAsc'),
    name_desc: t('publicSortNameDesc'),
  };
  return (
    <Panel title={t('publicCatalogueTitle')}>
      <div className="academy-lms-stack">
        <p className="muted">
          <Copy k="publicSignInPrompt" />
        </p>
        <div className="academy-public-controls">
          <Field
            label={t('publicSearchLabel')}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE);
            }}
          />
          <Select
            label={t('publicSortLabel')}
            value={sort}
            onChange={(next) => setSort(next as Sort)}
            options={sorts.map((value) => ({ value, label: sortLabels[value] }))}
          />
        </div>
        {list.resource.status === 'loading' ? (
          <Loading />
        ) : list.resource.status === 'failed' ? (
          <AcademyRefusal failure={list.resource.failure} retry={list.reload} />
        ) : list.resource.data.length === 0 ? (
          <EmptyState title={q ? t('publicNoMatch', { query: q }) : t('publicNothingPublished')} />
        ) : (
          <>
            <ul className="academy-public-cards" aria-label={t('publicCatalogueTitle')}>
              {list.resource.data.map((row) => (
                <li key={row.slug} className="academy-lms-card">
                  <a className="academy-learning-link" href={`/academy/${encodeURIComponent(row.slug)}`} lang="und">
                    {row.title}
                  </a>
                  <span data-testid="academy-lms-meta" className="academy-lms-meta">
                    <span>{pathLabel(t, row.path)}</span>
                    <span>{kindLabel(t, row.kind)}</span>
                    <span>
                      <Copy k="minutes" params={{ minutes: row.estimatedMinutes }} />
                    </span>
                  </span>
                  {row.summary && (
                    <p className="muted" lang="und">
                      {row.summary}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {list.resource.data.length === limit && (
              <Button variant="secondary" onClick={() => setLimit(limit + PAGE)}>
                <Copy k="publicShowMore" />
              </Button>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

function PublicReader({ slug }: { slug: string }) {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const lesson = useResource((signal) => api.query('academy', 'publicCurriculumItem', { slug }, item, { signal }), `public-item:${slug}`);
  const related = useResource(
    (signal) => api.query('academy', 'publicCurriculumRelated', { slug, limit: 5 }, z.array(summary), { signal }),
    `public-related:${slug}`,
  );
  if (lesson.resource.status === 'loading') return <Loading />;
  if (lesson.resource.status === 'failed')
    return (
      <Panel title={copyText('academy.learning')}>
        <AcademyRefusal failure={lesson.resource.failure} retry={lesson.reload} />
        <SignIn />
      </Panel>
    );
  const data = lesson.resource.data;
  return (
    <div className="more-columns">
      <Panel title={data.title}>
        <div className="academy-lms-stack">
          <nav className="academy-lms-crumbs" aria-label={t('breadcrumb')}>
            <a className="text-link" href="/academy">
              <Copy k="crumbAcademy" />
            </a>
            <span aria-hidden="true">/</span>
            <span>{isAcademyPath(data.path) ? pathLabel(t, data.path) : data.path}</span>
          </nav>
          <div data-testid="academy-lms-meta" className="academy-lms-meta">
            <span>{kindLabel(t, data.kind)}</span>
            <span>
              <Copy k="minutes" params={{ minutes: data.estimatedMinutes }} />
            </span>
          </div>
          {data.objectives.length > 0 && (
            <section aria-label={t('publicObjectives')}>
              <h3>{t('publicObjectives')}</h3>
              <ul lang="und">
                {data.objectives.map((objective) => (
                  <li key={objective}>{objective}</li>
                ))}
              </ul>
            </section>
          )}
          <article data-testid="more-body" className="more-body" lang="und">
            <LessonBody body={data.body} title={data.title} />
          </article>
          <p className="muted">
            <Copy k="publicSignInPrompt" />
          </p>
          <SignIn />
        </div>
      </Panel>
      {/* Related items only when the service names some: no block, and no filler, when there are none. */}
      {related.resource.status === 'ready' && related.resource.data.length > 0 && (
        <Panel title={t('publicRelated')}>
          <ul className="academy-public-cards">
            {related.resource.data.map((row) => (
              <li key={row.slug} className="academy-lms-card">
                <a className="academy-learning-link" href={`/academy/${encodeURIComponent(row.slug)}`} lang="und">
                  {row.title}
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function PublicVideos() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const list = useResource(
    (signal) =>
      api.query('academy', 'publicVideos', undefined, z.array(academyPublicVideoSchema), {
        signal,
      }),
    'public-videos',
  );
  return (
    <div className="more-columns">
      <Panel title={copyText('academy.video.library')}>
        <div className="academy-lms-stack">
          <p className="muted">
            <Copy k="videoIntro" />
          </p>
          {list.resource.status === 'loading' ? (
            <Loading />
          ) : list.resource.status === 'failed' ? (
            <AcademyRefusal failure={list.resource.failure} retry={list.reload} />
          ) : list.resource.data.length === 0 ? (
            <EmptyState title={copyText('academy.no.videos.are.available')} />
          ) : (
            <ul className="academy-public-cards">
              {list.resource.data.map((video) => (
                <li key={video.slug} className="academy-lms-card">
                  <strong lang="und">{video.title}</strong>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
      <Panel title={copyText('academy.playback')}>
        <EmptyState title={t('publicVideosSignIn')} action={<SignIn />} />
      </Panel>
    </div>
  );
}

function PublicCertificates() {
  const { t } = copy.useCopy();
  // Checking a certificate's code needs no account: the verify box is the same one signed-in learners use.
  const [reference, setReference] = useState(new URLSearchParams(location.search).get('verify') ?? '');
  return (
    <div className="more-columns">
      <Panel title={copyText('academy.certificates')}>
        <EmptyState title={t('publicCertificatesSignIn')} action={<SignIn />} />
      </Panel>
      <VerifyPanel reference={reference} onReference={setReference} />
    </div>
  );
}
