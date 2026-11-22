import { useId, type ReactNode } from 'react';
import { Button, Panel } from '../../shared/ui';
import { Details, Limit, Read, Select, type ActionControls } from './common';
import { t as copyText } from './copy';
import { academyLearningCopy as copy } from './academy-learning-copy';
import { isAcademyPath } from './academy-lms';
import { AcademyCatalogue } from './AcademyCatalogue';
import { academyLmsCopy } from './academy-lms-copy';
import { kindLabel, pathLabel } from './AcademyLmsParts';
import { lessonHref, useLearningState } from './academy-learning-state';
import './academy-learning.css';

/**
 * The hub's Learning tab: the original completion left behind, the catalogue, the learning path and the library. A lesson
 * opens in the reader (academy-reader/), which draws the same reads with the kit; the reads are academy-learning-state.ts.
 */
export function AcademyLearning({
  initialPath,
  certId,
  chooseCertificate,
  action,
}: {
  initialPath?: string;
  certId: string;
  chooseCertificate: (id: string) => void;
  action: ActionControls;
}) {
  const current = copy.useCopy(),
    { t: lms } = academyLmsCopy.useCopy();
  const { t, Copy } = current;
  const certificateControl = useId();
  const {
    path,
    setPath,
    kind,
    setKind,
    limit,
    setLimit,
    definitions,
    selected,
    progress,
    list,
    pathItems,
    overview,
    pending,
    certificateLink,
  } = useLearningState({ initialPath, certId, action });
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
      <p className="lt-muted">
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
          <label className="lt-field" htmlFor={certificateControl}>
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
        <p className="lt-muted">
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
              <p className="lt-muted">
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
                          <li key={s}>
                            <div>
                              <strong lang={lesson ? 'und' : 'zxx'}>{lesson?.title ?? s}</strong>
                              <small className="academy-learning-ref">
                                <Copy k={p.missingItemSlugs.includes(s) ? 'stillRequired' : 'recorded'} />
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
    <div lang={current.languageFor('learningPath')} className="academy-learning-stack">
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
      <Panel title={t('learningPath')} data-testid="academy-learning-path">
        {pathPanel}
      </Panel>
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
    </div>
  );
}
