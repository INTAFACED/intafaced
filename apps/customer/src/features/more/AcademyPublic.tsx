import { useState } from 'react';
import { ACADEMY_PUBLIC_CATALOGUE_SORTS, type AcademyPublicCatalogueSort } from '@intafaced/contracts/academy-catalogue';
import { navigate } from '../../app/location';
import { safeReturnTo } from '../../app/navigation';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Field, Loading, Panel, Tabs } from '../../shared/ui';
import { Select } from './common';
import './academy-public.css';
import { t as copyText } from './copy';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyTabHref, academyTabs, type AcademyRoute } from './academy-lms';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';
import { VerifyPanel } from './AcademyCertificates';
import { AcademyCourseCards, AcademyHub } from './AcademyHub';
import { ACADEMY_PUBLIC_CURRICULUM } from '@intafaced/contracts/academy-public-curriculum-procedures';
import { ACADEMY_PUBLIC_VIDEOS } from '@intafaced/contracts/academy-public-videos-procedures';

/**
 * The Academy for a visitor with no account (J-academy-01): the same five tabs at the same addresses, the published
 * catalogue with search and sort, and the reader. Nothing here reads or writes a learner record; the personal parts
 * say they need sign-in. Reads go to svc-academy's signed-out doors.
 */
const PAGE = 50;
const sorts = ACADEMY_PUBLIC_CATALOGUE_SORTS;
type Sort = AcademyPublicCatalogueSort;

function SignIn() {
  const { Copy } = copy.useCopy();
  const here = safeReturnTo(location.pathname + location.search);
  return (
    <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
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
      {route.kind === 'assignment' ? (
        <Panel title={copyText('academy.learning')}>
          <EmptyState title={t('asgSignIn')} action={<SignIn />} />
        </Panel>
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
    (signal) => api.call(ACADEMY_PUBLIC_CURRICULUM, { ...(q ? { q } : {}), sort, limit }, { signal }),
    `public-curriculum:${q}:${sort}:${limit}`,
  );
  const sortLabels: Record<Sort, string> = {
    recommended: t('publicSortRecommended'),
    name_asc: t('publicSortNameAsc'),
    name_desc: t('publicSortNameDesc'),
  };
  return (
    <Panel title={t('publicCatalogueTitle')}>
      <div className="lt-stack">
        <p className="lt-muted">
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
                    <p className="lt-muted" lang="und">
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

function PublicVideos() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const list = useResource(
    (signal) =>
      api.call(ACADEMY_PUBLIC_VIDEOS, undefined, {
        signal,
      }),
    'public-videos',
  );
  return (
    <div className="more-columns">
      <Panel title={copyText('academy.video.library')}>
        <div className="lt-stack">
          <p className="lt-muted">
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
