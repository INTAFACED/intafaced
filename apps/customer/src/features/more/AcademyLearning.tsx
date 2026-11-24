import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { SelectField } from '@intafaced/ui/lit/templates';
import type { ActionControls } from './common';
import { t as copyText } from './copy';
import { academyLearningCopy as copy } from './academy-learning-copy';
import { isAcademyPath } from './academy-lms';
import { AcademyCatalogue } from './AcademyCatalogue';
import { academyLmsCopy } from './academy-lms-copy';
import { kindLabel, pathLabel } from './academy-labels';
import { lessonHref, useLearningState } from './academy-learning-state';
import { KitDetails } from './volt-action';
import { KitLimit, KitRead, Section } from './volt-parts';

/**
 * The hub's Learning tab drawn with the kit (intafaced issue 9566): the original completion left behind, the catalogue,
 * the learning path and the library. A lesson opens in the reader (academy-reader/); the reads are academy-learning-state.ts.
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
  const pathPanel = (
    <div className="lt-stack">
      <KitRead resource={definitions.resource} retry={definitions.reload} empty={t('noCertificate')}>
        {(rows) => (
          <SelectField
            label={<Copy k="publishedCertificate" />}
            value={certId}
            onChange={chooseCertificate}
            options={[
              { value: '', label: t('chooseCertificate'), lang: current.languageFor('chooseCertificate') },
              ...rows.map((c) => ({ value: c.id, label: c.title, lang: 'und' })),
            ]}
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
            <>
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
                  <>
                    <ul className="lt-stack">
                      {selected.requiredItemSlugs.map((s) => {
                        const lesson = rows.find((r) => r.slug === s);
                        return (
                          <li key={s} className="lt-actions">
                            <div className="lt-stack">
                              <strong lang={lesson ? 'und' : 'zxx'}>{lesson?.title ?? s}</strong>
                              <small className="lt-hint">
                                <Copy k={p.missingItemSlugs.includes(s) ? 'stillRequired' : 'recorded'} />
                              </small>
                            </div>
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
                  </>
                )}
              </KitRead>
            </>
          )
        }
      </KitRead>
    </div>
  );
  return (
    <div lang={current.languageFor('learningPath')} className="lt-stack">
      {recovery}
      <KitRead resource={overview.resource} retry={overview.reload}>
        {(data) => (
          <AcademyCatalogue
            lessons={data.lessons}
            tracking={data.tracking}
            certId={certId}
            selectedPath={isAcademyPath(initialPath) ? initialPath : null}
          />
        )}
      </KitRead>
      <Section title={t('learningPath')} data-testid="academy-learning-path" className="lt-stack">
        {pathPanel}
      </Section>
      <Section title={copyText('academy.learning.library')} className="lt-stack">
        <div className="lt-actions">
          <SelectField
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
          <SelectField
            label={copyText('academy.content.kind')}
            value={kind}
            onChange={setKind}
            options={[
              { value: 'all', label: lms('kindAll') },
              ...(['playbook', 'workbook', 'lesson'] as const).map((value) => ({ value, label: kindLabel(lms, value) })),
            ]}
          />
        </div>
        <KitRead resource={list.resource} retry={list.reload} empty={copyText('academy.no.curriculum.items.match.this.path')}>
          {(rows) => (
            <>
              <div className="lt-stack">
                {rows.map((r) => (
                  <a className="lt-link lt-stack" key={r.slug} href={lessonHref(r.slug, certId, r.path)}>
                    <small>
                      <span>{kindLabel(lms, r.kind)}</span> · <Copy k="readingMinutes" params={{ minutes: r.estimatedMinutes }} />
                    </small>
                    <strong lang="und">{r.title}</strong>
                    <p lang="und">{r.summary}</p>
                  </a>
                ))}
              </div>
              <KitLimit count={rows.length} limit={limit} cap={200} onChange={setLimit} />
            </>
          )}
        </KitRead>
      </Section>
    </div>
  );
}
