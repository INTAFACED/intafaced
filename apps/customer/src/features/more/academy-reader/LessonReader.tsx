/**
 * The signed-in lesson reader drawn with the kit (intafaced issue 9568): the lesson in the learner's language with its
 * place in the path, video, objectives, body, key terms, quiz, completion review and coach; the learning path beside it;
 * and the original completion left behind. The reads are the hub's (../academy-learning-state.ts); only the drawing is
 * the kit's.
 */
import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import type { AcademyLocalizedItem } from '@intafaced/contracts/academy-learner-procedures';
import { currentPreferences } from '../../../shared/preferences';
import { t as copyText, Text } from '../copy';
import { academyLearningCopy as copy } from '../academy-learning-copy';
import { academyLmsCopy } from '../academy-lms-copy';
import { isAcademyPath } from '../academy-lms';
import { kindLabel, pathLabel } from '../academy-labels';
import { AcademyRefusal } from '../academy-refusal';
import { academyCodeOf, missingItems } from '../academy-flows';
import { lessonHref, useLearningState, type LearningState } from '../academy-learning-state';
import { AcademyCourseOutline } from '../AcademyCourseOutline';
import { Assessment } from '../AcademyAssessment';
import { AcademyCoach } from '../AcademyCoach';
import { LockedItemNotice, ReaderHeader, ReaderPager } from '../AcademyReaderParts';
import { Workbook } from '../Workbook';
import { KitDetails } from '../volt-action';
import { KitLimit, KitRead, Section } from '../volt-parts';
import type { ActionControls } from '../common';
import { LessonBody } from './lesson-body';
import { LessonVideo } from './LessonVideo';

/** What the completion review shows: what it records, the lesson, and the certificate it counts for. */
function ReviewContent({ lesson, certId }: { lesson: AcademyLocalizedItem; certId: string }) {
  const { Copy } = copy.useCopy();
  return (
    <div lang={copy.forLocale(currentPreferences().language).languageFor('reviewBoundary')} className="lt-stack">
      <p>
        <Copy k="reviewBoundary" />
      </p>
      <KitDetails
        items={[
          [copy.t('originalLesson'), <span lang="und">{lesson.title}</span>],
          ...(certId ? [[copy.t('certificateReference'), <code lang="zxx">{certId}</code>] as [string, ReactNode]] : []),
        ]}
      />
    </div>
  );
}

/** A completion sent earlier whose outcome was never read back: what it was, and the way back to it. */
function OriginalCompletion({ pending }: { pending: NonNullable<LearningState['pending']> }) {
  const { t, Copy } = copy.useCopy();
  return (
    <section className="lt-refusal" aria-label={t('unknownCompletion')}>
      <h3 className="lt-refusal-title">
        <Copy k="unknownCompletion" />
      </h3>
      <p className="lt-refusal-body">
        <Copy k="unknownBoundary" />
      </p>
      <KitDetails
        items={[
          [t('lessonReference'), <code lang="zxx">{pending.slug}</code>],
          ...(pending.certId ? [[t('certificateReference'), <code lang="zxx">{pending.certId}</code>] as [string, ReactNode]] : []),
        ]}
      />
      <p className="lt-hint">
        <Copy k="lookupDependency" />
      </p>
      <div className="lt-actions">
        <a className="lt-link lt-link-alone" href={lessonHref(pending.slug, pending.certId)}>
          <Copy k="returnOriginal" />
        </a>
        <a className="lt-link lt-link-alone" href="/support">
          <Copy k="contactSupport" />
        </a>
      </div>
    </section>
  );
}

/** The lesson itself, or why it cannot open. */
export function LessonArticle({
  state,
  certId,
  action,
  onProgress,
}: {
  state: LearningState;
  certId: string;
  action: ActionControls;
  onProgress?: () => void;
}) {
  const { t, Copy } = copy.useCopy(),
    { t: lms } = academyLmsCopy.useCopy();
  const { reader, overview, pending, receipt, receiptMatches, certificateLink } = state;
  return (
    <Section title={copyText('academy.learning.item')} data-testid="academy-lesson" className="lt-stack">
      {pending && <OriginalCompletion pending={pending} />}
      {/* A lesson held by its course start or window is refused in words; the outline beside it says when it opens. */}
      {reader.resource.status === 'failed' && academyCodeOf(reader.resource.failure) === 'academy.prerequisite_unmet' ? (
        <LockedItemNotice
          missing={missingItems(reader.resource.failure.message)}
          lessons={overview.resource.status === 'ready' ? overview.resource.data.lessons : []}
        />
      ) : reader.resource.status === 'failed' ? (
        <AcademyRefusal failure={reader.resource.failure} retry={reader.reload} />
      ) : (
        <KitRead resource={reader.resource} retry={reader.reload}>
          {(lesson) =>
            lesson && (
              <div className="lt-stack">
                <div className="lt-stack">
                  <h2 lang="und">{lesson.title}</h2>
                  <div className="lt-actions lt-hint">
                    <span>
                      <Copy k="readingMinutes" params={{ minutes: lesson.estimatedMinutes }} />
                    </span>
                    <span>
                      {isAcademyPath(lesson.path) ? pathLabel(lms, lesson.path) : lesson.path} · {kindLabel(lms, lesson.kind)}
                    </span>
                  </div>
                </div>
                <KitRead resource={overview.resource} retry={overview.reload}>
                  {(data) => <ReaderHeader slug={lesson.slug} path={lesson.path} lessons={data.lessons} tracking={data.tracking} />}
                </KitRead>
                <LessonVideo itemSlug={lesson.slug} onCompleted={onProgress} />
                {lesson.fellBack && (
                  <p className="lt-hint">
                    <Copy k="languageFallback" params={{ language: lesson.locale === 'en' ? t('englishBodyLanguage') : lesson.locale }} />
                  </p>
                )}
                <section className="lt-stack">
                  <h3>
                    <Text k="academy.learning.objectives" />
                  </h3>
                  <ul className="lt-stack" lang="und">
                    {lesson.objectives.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                </section>
                <article data-testid="more-body" className="lt-prose" lang={lesson.locale}>
                  <LessonBody body={lesson.body} title={lesson.title} />
                </article>
                <section className="lt-stack">
                  <h3>
                    <Text k="academy.key.terms" />
                  </h3>
                  <div lang="und">
                    <KitDetails items={lesson.keyTerms.map((term) => [term.term, term.definition])} />
                  </div>
                </section>
                <Assessment slug={lesson.slug} prompts={lesson.selfCheck} onFinished={onProgress} />
                {receiptMatches && receipt?.success && (
                  <section className="lt-stack" aria-label={t('completionReceipt')}>
                    <h3>
                      <Copy k="completionReceipt" />
                    </h3>
                    <p>
                      <Copy k="completionBoundary" />
                    </p>
                    <KitDetails
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
                    <p className="lt-hint">
                      <Copy k="receiptUnavailable" />
                    </p>
                  </section>
                )}
                <div className="lt-actions">
                  <Button
                    tone="primary"
                    disabled={action.disabled}
                    onClick={() => state.review(lesson, (shown, cert) => <ReviewContent lesson={shown} certId={cert} />)}
                  >
                    <Copy k="reviewCompletion" />
                  </Button>
                  <a
                    className="lt-link lt-link-alone"
                    href={certId ? certificateLink : `/academy?${new URLSearchParams({ path: lesson.path })}`}
                  >
                    <Copy k={certId ? 'returnCertificate' : 'returnLibrary'} />
                  </a>
                </div>
                {lesson.kind === 'workbook' && <Workbook slug={lesson.slug} />}
                <AcademyCoach lessonSlug={lesson.slug} />
                <KitRead resource={overview.resource} retry={overview.reload}>
                  {(data) => <ReaderPager slug={lesson.slug} path={lesson.path} lessons={data.lessons} certId={certId} />}
                </KitRead>
              </div>
            )
          }
        </KitRead>
      )}
    </Section>
  );
}

/** The learning path beside the lesson: the certificate chosen, its progress, and each lesson it needs. */
export function LearningPath({
  state,
  slug,
  certId,
  chooseCertificate,
}: {
  state: LearningState;
  slug: string;
  certId: string;
  chooseCertificate: (id: string) => void;
}) {
  const current = copy.useCopy();
  const { t, Copy } = current;
  const { definitions, progress, pathItems, selected, certificateLink } = state;
  return (
    <Section title={t('learningPath')} data-testid="academy-learning-path" lang={current.languageFor('learningPath')} className="lt-stack">
      <KitRead resource={definitions.resource} retry={definitions.reload} empty={t('noCertificate')}>
        {(rows) => (
          <SelectField
            label={<Copy k="publishedCertificate" />}
            value={certId}
            onChange={chooseCertificate}
            options={[{ value: '', label: t('chooseCertificate') }, ...rows.map((c) => ({ value: c.id, label: c.title }))]}
          />
        )}
      </KitRead>
      {!certId && (
        <p className="lt-hint">
          <Copy k="certificateHint" />
        </p>
      )}
      <KitRead resource={progress.resource} retry={progress.reload}>
        {(p) =>
          p &&
          selected && (
            <div className="lt-stack">
              <h2 lang="und">{p.title}</h2>
              <p role="status">
                <Copy k="completedCount" params={{ completed: p.completedCount, required: p.requiredCount }} />
              </p>
              <p className="lt-hint">
                <Copy k="progressBoundary" />
              </p>
              <div className="lt-actions">
                <Button tone="secondary" onClick={progress.reload}>
                  <Copy k="refreshProgress" />
                </Button>
              </div>
              <h3>
                <Copy k="requiredLessons" />
              </h3>
              <KitRead resource={pathItems.resource} retry={pathItems.reload}>
                {(rows) => (
                  <div className="lt-stack">
                    <ul className="lt-stack">
                      {selected.requiredItemSlugs.map((s) => {
                        const lesson = rows.find((r) => r.slug === s);
                        return (
                          <li key={s} className="lt-stack" aria-current={s === slug ? 'step' : undefined}>
                            <strong lang={lesson ? 'und' : 'zxx'}>{lesson?.title ?? s}</strong>
                            <small className="lt-hint">
                              <Copy k={p.missingItemSlugs.includes(s) ? 'stillRequired' : 'recorded'} />
                              {s === slug && (
                                <>
                                  {' '}
                                  · <Copy k="selectedLesson" />
                                </>
                              )}
                            </small>
                            <a className="lt-link lt-link-alone" href={lessonHref(s, certId, lesson?.path)}>
                              <Copy k="readLesson" />
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                    {p.missingItemSlugs.length > 0 ? (
                      <div className="lt-stack">
                        <h3>
                          <Copy k="nextLesson" />
                        </h3>
                        <strong lang={rows.some((r) => r.slug === p.missingItemSlugs[0]) ? 'und' : 'zxx'}>
                          {rows.find((r) => r.slug === p.missingItemSlugs[0])?.title ?? p.missingItemSlugs[0]}
                        </strong>
                        <a className="lt-link lt-link-alone" href={lessonHref(p.missingItemSlugs[0]!, certId)}>
                          <Copy k="readNext" />
                        </a>
                      </div>
                    ) : (
                      <p>
                        <Copy k="allRecorded" />
                      </p>
                    )}
                    <a className="lt-link lt-link-alone" href={certificateLink}>
                      <Copy k="returnCertificate" />
                    </a>
                    {rows.length >= 200 && <KitLimit count={rows.length} limit={200} cap={200} onChange={() => {}} />}
                  </div>
                )}
              </KitRead>
            </div>
          )
        }
      </KitRead>
    </Section>
  );
}

/**
 * The outline, the lesson and the path one under another, for the hub's Learning tab when an old `?slug=` address names a
 * lesson there: the same reader as /academy/:slug, inside the hub's own frame and action.
 */
export function LessonReaderStack({
  slug,
  initialPath,
  certId,
  chooseCertificate,
  action,
  onProgress,
  progress,
}: {
  slug: string;
  initialPath?: string;
  certId: string;
  chooseCertificate: (id: string) => void;
  action: ActionControls;
  onProgress?: () => void;
  progress: number;
}) {
  const state = useLearningState({ slug, initialPath, certId, action });
  return (
    <div className="lt-stack">
      <AcademyCourseOutline key={slug} itemSlug={slug} refresh={action.result} progress={progress} />
      <LessonArticle state={state} certId={certId} action={action} onProgress={onProgress} />
      <LearningPath state={state} slug={slug} certId={certId} chooseCertificate={chooseCertificate} />
    </div>
  );
}
