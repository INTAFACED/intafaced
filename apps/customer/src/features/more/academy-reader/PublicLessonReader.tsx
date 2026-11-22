/**
 * The lesson reader for a visitor with no account (J-academy-01), drawn with the kit (intafaced issue 9568): the
 * published lesson from svc-academy's signed-out door, its place, objectives and body, and the related items the service
 * names. Nothing here reads or writes a learner record; the personal parts say they need sign-in.
 */
import { ACADEMY_PUBLIC_CURRICULUM_ITEM } from '@intafaced/contracts/academy-public-curriculum-item-procedures';
import { ACADEMY_PUBLIC_CURRICULUM_RELATED } from '@intafaced/contracts/academy-public-curriculum-related-procedures';
import { safeReturnTo } from '../../../app/navigation';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session';
import { t as copyText } from '../copy';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { isAcademyPath } from '../academy-lms';
import { kindLabel, pathLabel } from '../academy-labels';
import { AcademyRefusal } from '../academy-refusal';
import { Section, Waiting } from '../volt-parts';
import { LessonBody } from './lesson-body';

/** Sign in and come back to this lesson. */
function SignIn() {
  const { Copy } = copy.useCopy();
  const here = safeReturnTo(location.pathname + location.search);
  return (
    <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent(here)}`}>
      <Copy k="publicSignIn" />
    </a>
  );
}

/** The published lesson, or why it cannot open. */
export function PublicLesson({ slug }: { slug: string }) {
  const api = useApi();
  const { t, Copy } = copy.useCopy();
  const lesson = useResource((signal) => api.call(ACADEMY_PUBLIC_CURRICULUM_ITEM, { slug }, { signal }), `public-item:${slug}`);
  if (lesson.resource.status === 'loading') return <Waiting />;
  if (lesson.resource.status === 'failed')
    return (
      <Section title={copyText('academy.learning')} className="lt-stack">
        <AcademyRefusal failure={lesson.resource.failure} retry={lesson.reload} />
        <SignIn />
      </Section>
    );
  const data = lesson.resource.data;
  return (
    <Section title={data.title} className="lt-stack">
      <nav className="lt-actions" aria-label={t('breadcrumb')}>
        <a className="lt-link lt-link-alone" href="/academy">
          <Copy k="crumbAcademy" />
        </a>
        <span aria-hidden="true">/</span>
        <span>{isAcademyPath(data.path) ? pathLabel(t, data.path) : data.path}</span>
      </nav>
      <div data-testid="academy-lms-meta" className="lt-actions lt-hint">
        <span>{kindLabel(t, data.kind)}</span>
        <span>
          <Copy k="minutes" params={{ minutes: data.estimatedMinutes }} />
        </span>
      </div>
      {data.objectives.length > 0 && (
        <section className="lt-stack" aria-label={t('publicObjectives')}>
          <h3>{t('publicObjectives')}</h3>
          <ul className="lt-stack" lang="und">
            {data.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </section>
      )}
      <article data-testid="more-body" className="lt-prose" lang="und">
        <LessonBody body={data.body} title={data.title} />
      </article>
      <p className="lt-hint">
        <Copy k="publicSignInPrompt" />
      </p>
      <SignIn />
    </Section>
  );
}

/** Related items only when the service names some: no block, and no filler, when there are none. */
export function PublicRelated({ slug }: { slug: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const related = useResource(
    (signal) => api.call(ACADEMY_PUBLIC_CURRICULUM_RELATED, { slug, limit: 5 }, { signal }),
    `public-related:${slug}`,
  );
  if (related.resource.status !== 'ready' || related.resource.data.length === 0) return null;
  return (
    <Section title={t('publicRelated')}>
      <ul className="lt-stack">
        {related.resource.data.map((row) => (
          <li key={row.slug}>
            <a className="lt-link lt-link-alone" href={`/academy/${encodeURIComponent(row.slug)}`} lang="und">
              {row.title}
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}
