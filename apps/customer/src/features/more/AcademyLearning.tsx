import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { currentPreferences, usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { Button, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, presentActionFailure, type ActionControls } from './common';
import { t as copyText, Text } from './copy';
import { Workbook } from './Workbook';
import { AcademyCoach } from './AcademyCoach';
import { academyLearningCopy as copy } from './academy-learning-copy';
import { isAcademyPath, rememberLastLesson } from './academy-lms';
import { useAcademyTracking } from './academy-tracking';
import { AcademyCatalogue } from './AcademyCatalogue';
import { academyLmsCopy } from './academy-lms-copy';
import { AcademyRefusal, kindLabel, pathLabel } from './AcademyLmsParts';
import { Assessment } from './AcademyAssessment';
import { LockedItemNotice, ReaderHeader, ReaderPager } from './AcademyReaderParts';
import { ItemVideo } from './AcademyVideoPlayer';
import { academyCodeOf, missingItems } from './academy-flows';
import './academy-learning.css';

const ref = z.string().min(1);
const unique = (values: string[]) => new Set(values).size === values.length;
const date = z.string().datetime({ offset: true });
const summary = z.object({
  slug: ref,
  title: ref,
  kind: z.enum(['playbook', 'workbook', 'lesson']),
  path: z.enum(['foundations', 'markets', 'builder', 'sovereign']),
  order: z.number().int().safe(),
  summary: z.string(),
  estimatedMinutes: z.number().int().safe().positive(),
});
const item = summary.extend({
  body: z.string(),
  objectives: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
  selfCheck: z.array(z.string()),
  locale: ref,
  fellBack: z.boolean(),
  i18nStrategy: z.string(),
});
export const certificateDefinitions = z
  .array(z.object({ id: ref, title: ref, requiredItemSlugs: z.array(ref).refine(unique) }))
  .refine((rows) => unique(rows.map((row) => row.id)));
export const certificateProgress = z.object({
  userId: z.string().guid(),
  certId: ref,
  title: ref,
  requiredCount: z.number().int().safe().positive(),
  completedCount: z.number().int().safe().nonnegative(),
  ratio: z.string(),
  missingItemSlugs: z.array(ref).refine(unique),
  complete: z.boolean(),
  granted: z.boolean(),
  grantIdempotencyKey: ref.nullable(),
});
export function progressFor(owner: string | null | undefined, certId: string, required: readonly string[]) {
  return certificateProgress.refine(
    (p) =>
      p.userId === owner &&
      p.certId === certId &&
      p.completedCount <= p.requiredCount &&
      p.missingItemSlugs.length === p.requiredCount - p.completedCount &&
      p.complete === (p.missingItemSlugs.length === 0) &&
      p.ratio === (p.requiredCount ? p.completedCount / p.requiredCount : 0).toFixed(4) &&
      (p.granted ? p.grantIdempotencyKey === `cert:${owner}:${certId}` : p.grantIdempotencyKey === null) &&
      p.requiredCount === required.length &&
      p.missingItemSlugs.every((s) => required.includes(s)) &&
      p.missingItemSlugs.join('|') === required.filter((s) => p.missingItemSlugs.includes(s)).join('|'),
  );
}
const completion = z.object({ userId: z.string().guid(), itemSlug: ref, completedAt: date });
const touched = z.object({ lastItemSlug: ref.nullable() });
type Context = { owner: string; certId: string; slug: string };
const contextSchema = z.object({ owner: z.string().guid(), certId: z.string(), slug: ref });
const selectionKey = (owner: string) => `intafaced:academy:certificate:${owner}`;
const originalKey = (owner: string) => `intafaced:academy:original-completion:${owner}`;
export function selectedCertificate(owner: string | null | undefined) {
  const requested = new URLSearchParams(window.location.search).get('cert');
  if (requested) return requested;
  if (!owner) return '';
  try {
    return localStorage.getItem(selectionKey(owner)) ?? '';
  } catch {
    return '';
  }
}
export function rememberCertificate(owner: string | null | undefined, certId: string) {
  if (!owner) return;
  try {
    localStorage.setItem(selectionKey(owner), certId);
  } catch {
    /* Reading remains available without persistence. */
  }
}
export function lessonHref(slug: string, certId: string, path?: string) {
  const params = new URLSearchParams();
  if (certId) params.set('cert', certId);
  if (path) params.set('path', path);
  return `/academy/${encodeURIComponent(slug)}${params.size ? '?' + params : ''}`;
}
function originalPending(owner: string | null | undefined): Context | null {
  if (!owner) return null;
  try {
    const raw = localStorage.getItem(originalKey(owner)),
      marker = localStorage.getItem(`intafaced:more:pending:${owner}:academy`);
    if (!raw || !marker) return null;
    const parsed = contextSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.owner === owner && JSON.parse(marker).reference === `curriculum:${parsed.data.slug}`)
      return parsed.data;
  } catch {
    /* A damaged context cannot prove the original request. Shared recovery remains blocked. */
  }
  return null;
}

export function AcademyLearning({
  slug,
  initialPath,
  certId,
  chooseCertificate,
  action,
  onProgress,
}: {
  slug?: string;
  initialPath?: string;
  certId: string;
  chooseCertificate: (id: string) => void;
  action: ActionControls;
  /** A quiz attempt was scored or a watched video completed an item, so a course rule may now be met. */
  onProgress?: () => void;
}) {
  const api = useApi(),
    { userId } = useSession(),
    { language } = usePreferences(),
    current = copy.useCopy(),
    { t: lms } = academyLmsCopy.useCopy();
  const { t, Copy } = current;
  const certificateControl = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [path, setPath] = useState(['foundations', 'markets', 'builder', 'sovereign'].includes(initialPath ?? '') ? initialPath! : 'all');
  const [kind, setKind] = useState('all'),
    [limit, setLimit] = useState(50);
  const context = useRef({ owner: userId, slug, certId });
  context.current = { owner: userId, slug, certId };
  const matches = (expected: typeof context.current) =>
    mounted.current &&
    action.isCurrent() &&
    api.canWrite() &&
    context.current.owner === expected.owner &&
    context.current.slug === expected.slug &&
    context.current.certId === expected.certId;
  const localFailure = (key: 'changed' | 'lessonChanged' | 'contextStorage') =>
    presentActionFailure(
      { ok: false as const, reason: key === 'contextStorage' ? ('error' as const) : ('aborted' as const), message: copy.t(key) },
      (locale) => {
        const presented = copy.forLocale(locale);
        return { message: presented.t(key), language: presented.languageFor(key) };
      },
    );
  const definitions = useResource(
    (signal) => api.query('academy', 'certDefinitions', undefined, certificateDefinitions, { signal }),
    `academy-learning-definitions:${userId}`,
  );
  const selected = definitions.resource.status === 'ready' ? definitions.resource.data.find((c) => c.id === certId) : undefined;
  const progress = useResource(
    (signal) =>
      selected
        ? api.query('academy', 'certProgress', { certId }, progressFor(userId, certId, selected.requiredItemSlugs), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `academy-learning-progress:${userId}:${certId}:${selected?.requiredItemSlugs.join('|') ?? ''}`,
  );
  const list = useResource(
    (signal) =>
      api.query(
        'academy',
        'curriculum',
        { limit, ...(path !== 'all' ? { path } : {}), ...(kind !== 'all' ? { kind } : {}) },
        z
          .array(summary)
          .max(limit)
          .refine(
            (rows) =>
              unique(rows.map((r) => r.slug)) &&
              rows.every((r) => (path === 'all' || r.path === path) && (kind === 'all' || r.kind === kind)),
          ),
        { signal },
      ),
    `academy-learning-library:${userId}:${path}:${kind}:${limit}`,
  );
  const reader = useResource(
    (signal) =>
      slug
        ? api.query(
            'academy',
            'curriculumItemLocalized',
            { slug, locale: language },
            item.refine((lesson) => lesson.slug === slug),
            { signal },
          )
        : Promise.resolve({ ok: true as const, data: null }),
    `academy-learning-reader:${userId}:${slug}:${language}`,
  );
  // Required lesson titles come from the actual unfiltered curriculum, independently of the reader/library filters.
  const pathItems = useResource(
    (signal) =>
      certId
        ? api.query(
            'academy',
            'curriculum',
            { limit: 200 },
            z
              .array(summary)
              .max(200)
              .refine((rows) => unique(rows.map((r) => r.slug))),
            { signal },
          )
        : Promise.resolve({ ok: true as const, data: [] as z.infer<typeof summary>[] }),
    `academy-learning-path-items:${userId}:${certId}`,
  );
  const overview = useAcademyTracking();
  const openedLesson = reader.resource.status === 'ready' ? reader.resource.data?.slug : undefined;
  // One reader on screen is one visit: the key is this reader's mount, so an effect run twice for the same lesson
  // (a remount check, a session refresh) is one opening, and opening the lesson again later is another.
  const visit = useRef(`${Date.now().toString(36)}`);
  useEffect(() => {
    if (!openedLesson) return;
    rememberLastLesson(userId, openedLesson);
    // Academy keeps where this account last read, so Continue opens the same item on any device. A failed write leaves
    // the lesson readable and Continue where it was; it is not worth a notice on the lesson.
    void api.mutate('academy', 'touchLesson', { slug: openedLesson, clientRequestId: `open:${openedLesson}:${visit.current}` }, touched);
  }, [userId, openedLesson]);
  const pending = originalPending(userId);
  const receipt = action.result?.ok ? completion.safeParse(action.result.data) : null;
  const receiptMatches = receipt?.success && receipt.data.userId === userId && receipt.data.itemSlug === slug;
  const certificateLink = `/academy/certificates${certId ? `?${new URLSearchParams({ cert: certId })}` : ''}`;
  function review(lesson: z.infer<typeof item>) {
    const expected = { ...context.current },
      originalLocale = language;
    action.stage({
      title: () => copy.t('reviewCompletion'),
      confirm: () => copy.t('recordCompletion'),
      success: () => copy.t('completionRecorded'),
      reference: `curriculum:${lesson.slug}`,
      content: () => (
        <div lang={copy.forLocale(currentPreferences().language).languageFor('reviewBoundary')} className="academy-learning-stack">
          <p>
            <Copy k="reviewBoundary" />
          </p>
          <Details
            items={[
              [copy.t('originalLesson'), <span lang="und">{lesson.title}</span>],
              ...(expected.certId
                ? [[copy.t('certificateReference'), <code lang="zxx">{expected.certId}</code>] as [string, ReactNode]]
                : []),
            ]}
          />
        </div>
      ),
      run: async (canDispatch) => {
        if (!canDispatch() || !matches(expected)) return localFailure('changed');
        try {
          localStorage.setItem(
            originalKey(expected.owner!),
            JSON.stringify({ owner: expected.owner, certId: expected.certId, slug: lesson.slug }),
          );
        } catch {
          return localFailure('contextStorage');
        }
        const fresh = await api.query(
          'academy',
          'curriculumItemLocalized',
          { slug: lesson.slug, locale: originalLocale },
          item.refine((r) => r.slug === lesson.slug),
        );
        if (!canDispatch() || !matches(expected)) return localFailure('changed');
        if (!fresh.ok) return fresh;
        if (
          fresh.data.title !== lesson.title ||
          fresh.data.body !== lesson.body ||
          fresh.data.kind !== lesson.kind ||
          fresh.data.path !== lesson.path
        )
          return localFailure('lessonChanged');
        if (!canDispatch() || !matches(expected)) return localFailure('changed');
        return api.mutate(
          'academy',
          'markCurriculumComplete',
          { itemSlug: lesson.slug },
          completion.refine((r) => r.userId === expected.owner && r.itemSlug === lesson.slug),
        );
      },
      done: () => {
        if (matches(expected)) progress.reload();
      },
    });
  }
  const recovery = pending && (
    <section className="academy-learning-unknown" aria-label={t('unknownCompletion')}>
      <h3>
        <Copy k="unknownCompletion" />
      </h3>
      <p>
        <Copy k="unknownBoundary" />
      </p>
      <Details
        items={[
          [t('lessonReference'), <code lang="zxx">{pending.slug}</code>],
          ...(pending.certId ? [[t('certificateReference'), <code lang="zxx">{pending.certId}</code>] as [string, ReactNode]] : []),
        ]}
      />
      <p className="muted">
        <Copy k="lookupDependency" />
      </p>
      <div className="academy-learning-actions">
        <a className="academy-learning-link" href={lessonHref(pending.slug, pending.certId)}>
          <Copy k="returnOriginal" />
        </a>
        <a className="academy-learning-link" href="/support">
          <Copy k="contactSupport" />
        </a>
      </div>
    </section>
  );
  const pathPanel = (
    <div className="academy-learning-stack">
      <Read resource={definitions.resource} retry={definitions.reload} empty={t('noCertificate')}>
        {(rows) => (
          <label className="field" htmlFor={certificateControl}>
            <span>
              <Copy k="publishedCertificate" />
            </span>
            <select id={certificateControl} value={certId} onChange={(event) => chooseCertificate(event.target.value)}>
              <option value="" lang={current.languageFor('chooseCertificate')}>
                {t('chooseCertificate')}
              </option>
              {rows.map((c) => (
                <option key={c.id} value={c.id} lang="und">
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </Read>
      {!certId && (
        <p className="muted">
          <Copy k="certificateHint" />
        </p>
      )}
      <Read resource={progress.resource} retry={progress.reload}>
        {(p) =>
          p &&
          selected && (
            <>
              <h2 lang="und">{p.title}</h2>
              <p role="status">
                <Copy k="completedCount" params={{ completed: p.completedCount, required: p.requiredCount }} />
              </p>
              <p className="muted">
                <Copy k="progressBoundary" />
              </p>
              <div className="academy-learning-actions">
                <Button variant="secondary" onClick={progress.reload}>
                  <Copy k="refreshProgress" />
                </Button>
              </div>
              <h3>
                <Copy k="requiredLessons" />
              </h3>
              <Read resource={pathItems.resource} retry={pathItems.reload}>
                {(rows) => (
                  <>
                    <ul className="academy-learning-lessons">
                      {selected.requiredItemSlugs.map((s) => {
                        const lesson = rows.find((r) => r.slug === s);
                        return (
                          <li key={s} aria-current={s === slug ? 'step' : undefined}>
                            <div>
                              <strong lang={lesson ? 'und' : 'zxx'}>{lesson?.title ?? s}</strong>
                              <small className="academy-learning-ref">
                                <Copy k={p.missingItemSlugs.includes(s) ? 'stillRequired' : 'recorded'} />
                                {s === slug && (
                                  <>
                                    {' '}
                                    · <Copy k="selectedLesson" />
                                  </>
                                )}
                              </small>
                            </div>
                            <a className="academy-learning-link" href={lessonHref(s, certId, lesson?.path)}>
                              <Copy k="readLesson" />
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                    {p.missingItemSlugs.length > 0 ? (
                      <div className="academy-learning-stack">
                        <h3>
                          <Copy k="nextLesson" />
                        </h3>
                        <strong lang={rows.some((r) => r.slug === p.missingItemSlugs[0]) ? 'und' : 'zxx'}>
                          {rows.find((r) => r.slug === p.missingItemSlugs[0])?.title ?? p.missingItemSlugs[0]}
                        </strong>
                        <a className="academy-learning-link" href={lessonHref(p.missingItemSlugs[0]!, certId)}>
                          <Copy k="readNext" />
                        </a>
                      </div>
                    ) : (
                      <p>
                        <Copy k="allRecorded" />
                      </p>
                    )}
                    <a className="academy-learning-link" href={certificateLink}>
                      <Copy k="returnCertificate" />
                    </a>
                    {rows.length >= 200 && <Limit count={rows.length} limit={200} cap={200} onChange={() => {}} />}
                  </>
                )}
              </Read>
            </>
          )
        }
      </Read>
    </div>
  );
  return (
    <div lang={current.languageFor('learningPath')} className={slug ? 'academy-learning-layout' : 'academy-learning-stack'}>
      {slug ? (
        <div className="academy-learning-reader">
          <Panel title={copyText('academy.learning.item')}>
            <div className="academy-learning-stack">
              {recovery}
              {/* A lesson held by its course start or window is refused in words; the outline beside it says when it opens. */}
              {reader.resource.status === 'failed' && academyCodeOf(reader.resource.failure) === 'academy.prerequisite_unmet' ? (
                <LockedItemNotice
                  missing={missingItems(reader.resource.failure.message)}
                  lessons={overview.resource.status === 'ready' ? overview.resource.data.lessons : []}
                />
              ) : reader.resource.status === 'failed' ? (
                <AcademyRefusal failure={reader.resource.failure} retry={reader.reload} />
              ) : (
                <Read resource={reader.resource} retry={reader.reload}>
                  {(lesson) =>
                    lesson && (
                      <>
                        <div>
                          <h2 lang="und">{lesson.title}</h2>
                          <div className="academy-learning-meta">
                            <span>
                              <Copy k="readingMinutes" params={{ minutes: lesson.estimatedMinutes }} />
                            </span>
                            <span>
                              {isAcademyPath(lesson.path) ? pathLabel(lms, lesson.path) : lesson.path} · {kindLabel(lms, lesson.kind)}
                            </span>
                          </div>
                        </div>
                        <Read resource={overview.resource} retry={overview.reload}>
                          {(data) => <ReaderHeader slug={lesson.slug} path={lesson.path} lessons={data.lessons} tracking={data.tracking} />}
                        </Read>
                        <ItemVideo itemSlug={lesson.slug} onCompleted={onProgress} />
                        {lesson.fellBack && (
                          <p className="muted">
                            <Copy
                              k="languageFallback"
                              params={{ language: lesson.locale === 'en' ? t('englishBodyLanguage') : lesson.locale }}
                            />
                          </p>
                        )}
                        <section>
                          <h3>
                            <Text k="academy.learning.objectives" />
                          </h3>
                          <ul lang="und">
                            {lesson.objectives.map((o) => (
                              <li key={o}>{o}</li>
                            ))}
                          </ul>
                        </section>
                        <article data-testid="more-body" className="more-body" lang={lesson.locale}>
                          <LessonBody body={lesson.body} title={lesson.title} />
                        </article>
                        <section>
                          <h3>
                            <Text k="academy.key.terms" />
                          </h3>
                          <div lang="und">
                            <Details items={lesson.keyTerms.map((term) => [term.term, term.definition])} />
                          </div>
                        </section>
                        <Assessment slug={lesson.slug} prompts={lesson.selfCheck} onFinished={onProgress} />
                        {receiptMatches && receipt?.success && (
                          <section className="academy-learning-receipt" aria-label={t('completionReceipt')}>
                            <h3>
                              <Copy k="completionReceipt" />
                            </h3>
                            <p>
                              <Copy k="completionBoundary" />
                            </p>
                            <Details
                              items={[
                                [
                                  t('recordedAt'),
                                  <time dateTime={receipt.data.completedAt} lang="zxx">
                                    {receipt.data.completedAt}
                                  </time>,
                                ],
                                [t('originalLesson'), <span lang="und">{lesson.title}</span>],
                                [copyText('common.acting.as.account'), <code lang="zxx">{receipt.data.userId}</code>],
                              ]}
                            />
                            <p className="muted">
                              <Copy k="receiptUnavailable" />
                            </p>
                          </section>
                        )}
                        <div className="academy-learning-actions">
                          <Button disabled={action.disabled} onClick={() => review(lesson)}>
                            <Copy k="reviewCompletion" />
                          </Button>
                          <a
                            className="academy-learning-link"
                            href={certId ? certificateLink : `/academy?${new URLSearchParams({ path: lesson.path })}`}
                          >
                            <Copy k={certId ? 'returnCertificate' : 'returnLibrary'} />
                          </a>
                        </div>
                        {lesson.kind === 'workbook' && <Workbook slug={lesson.slug} />}
                        <AcademyCoach lessonSlug={lesson.slug} />
                        <Read resource={overview.resource} retry={overview.reload}>
                          {(data) => <ReaderPager slug={lesson.slug} path={lesson.path} lessons={data.lessons} certId={certId} />}
                        </Read>
                      </>
                    )
                  }
                </Read>
              )}
            </div>
          </Panel>
        </div>
      ) : (
        <>
          {recovery}
          <Read resource={overview.resource} retry={overview.reload}>
            {(data) => (
              <AcademyCatalogue
                lessons={data.lessons}
                tracking={data.tracking}
                certId={certId}
                selectedPath={isAcademyPath(initialPath) ? initialPath : null}
              />
            )}
          </Read>
          <Panel title={t('learningPath')}>{pathPanel}</Panel>
          <Panel title={copyText('academy.learning.library')}>
            <div className="more-inline">
              <Select
                label={copyText('academy.learning.path')}
                value={path}
                onChange={setPath}
                options={[
                  { value: 'all', label: lms('allPaths') },
                  ...(['foundations', 'markets', 'builder', 'sovereign'] as const).map((value) => ({
                    value,
                    label: pathLabel(lms, value),
                  })),
                ]}
              />
              <Select
                label={copyText('academy.content.kind')}
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: lms('kindAll') },
                  ...(['playbook', 'workbook', 'lesson'] as const).map((value) => ({ value, label: kindLabel(lms, value) })),
                ]}
              />
            </div>
            <Read resource={list.resource} retry={list.reload} empty={copyText('academy.no.curriculum.items.match.this.path')}>
              {(rows) => (
                <>
                  <div className="more-rooms">
                    {rows.map((r) => (
                      <a className="more-room-link" key={r.slug} href={lessonHref(r.slug, certId, r.path)}>
                        <small>
                          <span>{kindLabel(lms, r.kind)}</span> · <Copy k="readingMinutes" params={{ minutes: r.estimatedMinutes }} />
                        </small>
                        <strong lang="und">{r.title}</strong>
                        <p lang="und">{r.summary}</p>
                      </a>
                    ))}
                  </div>
                  <Limit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
                </>
              )}
            </Read>
          </Panel>
        </>
      )}
      {slug && (
        <div className="academy-learning-path">
          <Panel title={t('learningPath')}>{pathPanel}</Panel>
        </div>
      )}
    </div>
  );
}

function inlineText(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith('`') && part.endsWith('`') ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}
export function LessonBody({ body, title }: { body: string; title: string }) {
  return (
    <>
      {body
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((block, index) => {
          if (/^#{1,3} /.test(block)) {
            const heading = block.replace(/^#+ /, '').trim();
            return heading === title ? null : <h3 key={index}>{inlineText(heading)}</h3>;
          }
          if (block.startsWith('```'))
            return (
              <pre key={index}>
                <code>{block.replace(/^```[^\n]*\n/, '').replace(/\n```$/, '')}</code>
              </pre>
            );
          const lines = block.split('\n'),
            ordered = /^\d+\. /.test(lines[0] ?? ''),
            unordered = /^[-*] /.test(lines[0] ?? '');
          if (ordered || unordered) {
            const entries: string[] = [];
            for (const line of lines) {
              if (/^(?:\d+\.|[-*]) /.test(line)) entries.push(line.replace(/^(?:\d+\.|[-*]) /, ''));
              else if (entries.length) entries[entries.length - 1] += ' ' + line;
            }
            const children = entries.map((entry, n) => <li key={n}>{inlineText(entry)}</li>);
            return ordered ? <ol key={index}>{children}</ol> : <ul key={index}>{children}</ul>;
          }
          return <p key={index}>{inlineText(lines.join(' '))}</p>;
        })}
    </>
  );
}
