import type { ReactNode } from 'react';
import { type AcademyPublicHubLesson } from '@intafaced/contracts/academy-catalogue';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { ServiceOffNotice } from '../../shared/service-off';
import { EmptyState, Loading, Panel } from '../../shared/ui';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref } from './academy-lms';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';
import { priceText } from './academy-course-words';
import './academy-public.css';
import { ACADEMY_PUBLIC_HUB } from '@intafaced/contracts/academy-public-hub-procedures';
import { ACADEMY_PUBLIC_COURSES } from '@intafaced/contracts/academy-public-courses-procedures';
import { ACADEMY_PUBLIC_AUTHORED_COURSES } from '@intafaced/contracts/academy-public-authored-courses-procedures';

/**
 * The hub above the five tabs on `/academy` (AC-articles-01): the featured slot holds only what staff chose, and says
 * nothing is featured otherwise; the news block needs a news data feed and shows that notice, never a headline.
 */
export function AcademyHub() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const hub = useResource((signal) => api.call(ACADEMY_PUBLIC_HUB, undefined, { signal }), 'public-hub');
  const featured = hub.resource.status === 'ready' ? hub.resource.data.featured : null;
  const lesson = hub.resource.status === 'ready' ? hub.resource.data.lesson : null;
  return (
    <div className="more-columns" data-academy-hub="true">
      <Panel title={t('hubFeatured')}>
        {hub.resource.status === 'loading' ? (
          <Loading />
        ) : hub.resource.status === 'failed' ? (
          <AcademyRefusal failure={hub.resource.failure} retry={hub.reload} />
        ) : featured ? (
          <article className="academy-lms-card">
            <a className="academy-learning-link" href={`/academy/${encodeURIComponent(featured.slug)}`} lang="und">
              {featured.title}
            </a>
            <span data-testid="academy-lms-meta" className="academy-lms-meta">
              <span>{pathLabel(t, featured.path)}</span>
              <span>{kindLabel(t, featured.kind)}</span>
              <span>
                <Copy k="minutes" params={{ minutes: featured.estimatedMinutes }} />
              </span>
            </span>
            {featured.summary && (
              <p className="lt-muted" lang="und">
                {featured.summary}
              </p>
            )}
          </article>
        ) : lesson ? (
          <FeaturedLessonCard lesson={lesson} />
        ) : (
          <EmptyState title={t('hubNothingFeatured')} />
        )}
      </Panel>
      <Panel title={t('hubNews')}>
        <ServiceOffNotice code="feed.news" action={t('hubNewsAction')} role="status" />
      </Panel>
    </div>
  );
}

/**
 * A course lesson staff featured: its title and course, and Open the course only while the course is published (its page
 * is public then); a draft course's lesson says there is no course page yet.
 */
export function FeaturedLessonCard({ lesson }: { lesson: AcademyPublicHubLesson }) {
  const { Copy } = copy.useCopy();
  return (
    <article className="academy-lms-card" data-featured-lesson="true">
      <h3 lang="und">{lesson.title}</h3>
      <p className="lt-muted">
        <Copy k="hubLessonFrom" params={{ course: lesson.courseTitle }} />
      </p>
      {lesson.courseSlug ? (
        <a className="academy-learning-link" href={academyCourseHref(lesson.courseSlug)}>
          <Copy k="hubLessonOpen" />
        </a>
      ) : (
        <p className="lt-muted">
          <Copy k="hubLessonNotOpen" />
        </p>
      )}
    </article>
  );
}

/** One card per course with published items, then the published courses staff made, above the item catalogue. */
export function AcademyCourseCards() {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const cards = useResource((signal) => api.call(ACADEMY_PUBLIC_COURSES, undefined, { signal }), 'public-courses');
  if (cards.resource.status === 'loading') return <Loading />;
  if (cards.resource.status === 'failed') return <AcademyRefusal failure={cards.resource.failure} retry={cards.reload} />;
  if (cards.resource.data.length === 0)
    // Nothing is published only when no course staff made is either.
    return <AcademyAuthoredCourseCards whenEmpty={<EmptyState title={t('publicNothingPublished')} />} />;
  return (
    <>
      <ul className="academy-public-cards" aria-label={t('publicCourses')}>
        {cards.resource.data.map((card) => (
          <li key={card.slug} className="academy-lms-card">
            <a className="academy-learning-link" href={academyCourseHref(card.slug)}>
              {pathLabel(t, card.slug)}
            </a>
            <span data-testid="academy-lms-meta" className="academy-lms-meta">
              <Copy k="courseItems" params={{ count: card.items, minutes: card.estimatedMinutes }} />
            </span>
          </li>
        ))}
      </ul>
      <AcademyAuthoredCourseCards />
    </>
  );
}

/** The page size the catalogue of courses staff made asks for. */
const CARDS_PAGE = 50;

/** One card per published course staff made, most recently published first; `whenEmpty` shows when there is none. */
function AcademyAuthoredCourseCards({ whenEmpty = null }: { whenEmpty?: ReactNode }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const cards = useResource(
    (signal) => api.call(ACADEMY_PUBLIC_AUTHORED_COURSES, { limit: CARDS_PAGE }, { signal }),
    'public-authored-courses',
  );
  if (cards.resource.status === 'loading') return <Loading />;
  if (cards.resource.status === 'failed') return <AcademyRefusal failure={cards.resource.failure} retry={cards.reload} />;
  if (cards.resource.data.length === 0) return <>{whenEmpty}</>;
  return (
    <ul className="academy-public-cards" aria-label={t('publicAuthoredCourses')} data-academy-authored-cards="true">
      {cards.resource.data.map((card) => (
        <li key={card.slug} className="academy-lms-card">
          <a className="academy-learning-link" href={academyCourseHref(card.slug)} lang="und">
            {card.title}
          </a>
          <span data-testid="academy-lms-meta" className="academy-lms-meta">
            <span>{t('authoredItems', { count: card.items })}</span>
            <span>{priceText(t, card)}</span>
          </span>
          {card.summary && (
            <p className="lt-muted" lang="und">
              {card.summary}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
