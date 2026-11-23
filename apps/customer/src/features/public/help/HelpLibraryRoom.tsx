// volt-room: /help/category/:id
// volt-room: /help/section/:id
import type { ReactNode } from 'react';
import { Button, EmptyState } from '@intafaced/ui/lit';
import { ReadingTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { SUPPORT_KB_LIBRARY } from '@intafaced/contracts/support-desk-settings-procedures';
import { SUPPORT_HELP_CENTRE_OFF } from '@intafaced/contracts/support-help-centre';
import { supportKbParagraphs } from '@intafaced/contracts/support-kb-library';
import type { ApiResult } from '../../../shared/api';
import { readContract } from '../../../shared/contract-call';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { helpCopy as copy } from '../help-copy';
import { helpHref } from '../help-guards';
import { HELP_SECTION_WINDOW, helpCategoryHref, helpSectionHref, helpSectionRead, type HelpLibraryPath } from '../help-library';
import { FailureNote } from '../../more';
import { ContactSupport } from './ContactSupport';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** A refusal the page has its own words for: switched off, or a topic that is not there. */
function libraryRefusal(failure: { message?: string; status?: number }) {
  if (failure.message === SUPPORT_HELP_CENTRE_OFF) return 'off' as const;
  if (failure.status === 404) return 'missing' as const;
  return null;
}

function Crumbs({ category }: { category?: { id: string; name: string } }) {
  const { t, languageFor } = copy.useCopy();
  return (
    <nav aria-label={t('breadcrumbs')}>
      <a href="/help" className="lt-link" lang={languageFor('libraryHome')}>
        {t('libraryHome')}
      </a>
      {category && (
        <>
          {' › '}
          <a href={helpCategoryHref(category.id)} className="lt-link" lang="und">
            {category.name}
          </a>
        </>
      )}
    </nav>
  );
}

/** One room on the reading template; every page of the library draws through it, its state named by the caller. */
function LibraryRoom({
  title,
  state = { kind: 'ready' },
  testId,
  meta,
  body,
}: {
  title: string;
  state?: RoomState;
  testId?: string;
  meta?: ReactNode;
  body?: ReactNode;
}) {
  const { languageFor } = copy.useCopy();
  return (
    <div data-room="help-library" data-testid={testId} lang={languageFor('title')}>
      <ReadingTemplate title={title} state={state} meta={meta} body={body ?? null} contact={<ContactSupport />} />
    </div>
  );
}

/** Switched off, or a topic that is not there: the template's refusal, with the way back to the help centre. */
function Refused({ kind }: { kind: 'off' | 'missing' }) {
  const { t } = copy.useCopy();
  const title = kind === 'off' ? 'switchedOffTitle' : 'libraryMissingTitle';
  const body = kind === 'off' ? 'switchedOffBody' : 'libraryMissingBody';
  return (
    <LibraryRoom
      title={t('libraryHome')}
      testId={kind === 'off' ? 'help-centre-off' : 'help-topic-missing'}
      state={{
        kind: 'refused',
        refusal: { variant: 'refused', title: t(title), body: t(body), action: { label: t('libraryHome'), href: '/help' } },
      }}
    />
  );
}

/** A read that failed for another reason: the failure in its own words, and a way to read again. */
function Unread({ failure, reload }: { failure: Failed; reload: () => void }) {
  const { t } = copy.useCopy();
  const refused = libraryRefusal(failure);
  if (refused) return <Refused kind={refused} />;
  return (
    <LibraryRoom
      title={t('libraryHome')}
      meta={<Crumbs />}
      body={
        <div className="lt-stack">
          <div lang="und">
            <FailureNote result={failure} />
          </div>
          <div className="lt-actions">
            <Button tone="primary" onClick={reload}>
              {t('retry')}
            </Button>
          </div>
        </div>
      }
    />
  );
}

/** `/help/category/<id>`: one category and its sections, each with its count of published answers. */
function CategoryPage({ id }: { id: string }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const library = useResource((signal) => api.call(SUPPORT_KB_LIBRARY, undefined, { signal }), `help-library:${userId ?? 'public'}`);
  const read = library.resource;
  if (read.status === 'loading') return <LibraryRoom title={t('libraryHome')} state={{ kind: 'loading' }} />;
  if (read.status === 'failed') return <Unread failure={read.failure} reload={library.reload} />;
  const category = read.data.categories.find((row) => row.id === id);
  if (!category) return <Refused kind="missing" />;
  return (
    <LibraryRoom
      title={category.name}
      meta={<Crumbs />}
      body={
        <div className="lt-stack">
          {category.sections.length === 0 && (
            <div role="status">
              <EmptyState title={t('categoryEmptyTitle')} />
            </div>
          )}
          {category.sections.map((section) => (
            <article data-testid="help__row" className="lt-stack" key={section.id}>
              <h2 lang="und">{section.name}</h2>
              <a href={helpSectionHref(section.id)} className="lt-link" aria-label={`${t('openSection')}: ${section.name}`}>
                {t('openSection')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
              <p className="lt-hint">
                {t('answersLabel')} <span lang="zxx">{section.articleCount}</span>
              </p>
            </article>
          ))}
        </div>
      }
    />
  );
}

/** `/help/section/<id>`: only the published answers filed under this section, or an honest empty state. */
function SectionPage({ id }: { id: string }) {
  const { t } = copy.useCopy();
  const { api, userId } = useSession();
  const page = useResource(
    (signal) => readContract(api, helpSectionRead, { sectionId: id, limit: HELP_SECTION_WINDOW }, { signal }),
    `help-section:${id}:${userId ?? 'public'}`,
  );
  const read = page.resource;
  if (read.status === 'loading') return <LibraryRoom title={t('libraryHome')} state={{ kind: 'loading' }} />;
  if (read.status === 'failed') return <Unread failure={read.failure} reload={page.reload} />;
  const { category, section, articles } = read.data;
  return (
    <LibraryRoom
      title={section.name}
      meta={<Crumbs category={category} />}
      body={
        <div className="lt-stack">
          {articles.length === 0 ? (
            <div role="status">
              <EmptyState title={t('sectionEmptyTitle')} body={t('sectionEmptyBody')} />
            </div>
          ) : (
            articles.map((row) => {
              const title = row.title ?? row.id;
              const first = row.body ? supportKbParagraphs(row.body)[0] : undefined;
              return (
                <article data-testid="help__row" className="lt-stack" key={row.id}>
                  <h2 lang={row.language ?? 'und'}>{title}</h2>
                  <a href={helpHref(row.id)} className="lt-link" aria-label={`${t('readAnswer')}: ${title}`}>
                    {t('readAnswer')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
                  </a>
                  {first && <p lang={row.language ?? 'und'}>{first}</p>}
                </article>
              );
            })
          )}
          {articles.length === HELP_SECTION_WINDOW && <p className="lt-hint">{t('sectionWindow')}</p>}
        </div>
      }
    />
  );
}

/** `/help/category/<id>` and `/help/section/<id>` (SP-kb-01), on the reading template. */
export function HelpLibraryRoom({ at }: { at: Exclude<HelpLibraryPath, null> }) {
  return at.kind === 'category' ? <CategoryPage id={at.id} /> : <SectionPage id={at.id} />;
}
