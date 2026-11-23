import { useState } from 'react';
import { ACADEMY_PUBLIC_CATALOGUE_SORTS, type AcademyPublicCatalogueSort } from '@intafaced/contracts/academy-catalogue';
import { ACADEMY_PUBLIC_CURRICULUM } from '@intafaced/contracts/academy-public-curriculum-procedures';
import { Button } from '@intafaced/ui/lit';
import { SelectField, TextField } from '@intafaced/ui/lit/templates';
import { useApi } from '../../session';
import { useResource } from '../../../shared/resource';
import { academyLmsCopy as copy } from '../academy-lms-copy';
import { kindLabel, pathLabel } from '../academy-labels';
import { AcademyRefusal } from '../academy-refusal';
import { AcademyCourseCards } from '../AcademyHub';
import { EmptyNote, Section, Waiting } from '../volt-parts';

const PAGE = 50;
const sorts = ACADEMY_PUBLIC_CATALOGUE_SORTS;
type Sort = AcademyPublicCatalogueSort;

/**
 * Learning for a visitor with no account (J-academy-01): the published courses, then the published catalogue with search
 * and sort. Nothing here reads or writes a learner record; reads go to svc-academy's signed-out doors.
 */
export function PublicLearning() {
  const { t } = copy.useCopy();
  return (
    <div className="lt-stack">
      <Section title={t('publicCourses')} className="lt-stack">
        <AcademyCourseCards />
      </Section>
      <PublicCatalogue />
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
    <Section title={t('publicCatalogueTitle')} className="lt-stack">
      <p className="lt-hint">
        <Copy k="publicSignInPrompt" />
      </p>
      <div className="lt-actions">
        <TextField
          label={t('publicSearchLabel')}
          type="search"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setLimit(PAGE);
          }}
        />
        <SelectField
          label={t('publicSortLabel')}
          value={sort}
          onChange={(next) => setSort(next as Sort)}
          options={sorts.map((value) => ({ value, label: sortLabels[value] }))}
        />
      </div>
      {list.resource.status === 'loading' ? (
        <Waiting />
      ) : list.resource.status === 'failed' ? (
        <AcademyRefusal failure={list.resource.failure} retry={list.reload} />
      ) : list.resource.data.length === 0 ? (
        <EmptyNote title={q ? t('publicNoMatch', { query: q }) : t('publicNothingPublished')} />
      ) : (
        <>
          <ul className="lt-stack" aria-label={t('publicCatalogueTitle')}>
            {list.resource.data.map((row) => (
              <li key={row.slug} className="lt-stack">
                <a className="lt-link lt-link-alone" href={`/academy/${encodeURIComponent(row.slug)}`} lang="und">
                  {row.title}
                </a>
                <span data-testid="academy-lms-meta" className="lt-actions lt-hint">
                  <span>{pathLabel(t, row.path)}</span>
                  <span>{kindLabel(t, row.kind)}</span>
                  <span>
                    <Copy k="minutes" params={{ minutes: row.estimatedMinutes }} />
                  </span>
                </span>
                {row.summary && (
                  <p className="lt-hint" lang="und">
                    {row.summary}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {list.resource.data.length === limit && (
            <Button tone="secondary" onClick={() => setLimit(limit + PAGE)}>
              <Copy k="publicShowMore" />
            </Button>
          )}
        </>
      )}
    </Section>
  );
}
