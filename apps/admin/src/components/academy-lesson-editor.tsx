'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ACADEMY_LESSON_BLOCK_TYPES, ACADEMY_LESSON_FORMAT, type AcademyLessonBlockType } from '@intafaced/contracts/academy-courses';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchLesson, postLessonChange } from '@/lib/academy/lessons-browser';
import { liveOf, type AcademyLesson, type AcademyLessonBlock, type LessonDeskReply, type LessonView } from '@/lib/academy/lessons-model';
import { AcademyNav, Failed, Outcome } from '@/components/academy-courses-desk';
import { move } from '@/components/academy-outline-editor';
import { explainRefusal } from '@/lib/desk/refusal-copy';

/**
 * LESSON EDITOR (AC-course-structure-03).
 *
 * One outline item's lesson as ordered blocks (text, image, audio, PDF, code). Every save is a new revision; revert
 * copies an older one into a new revision. Learners see only the revision published for the item and keep it while
 * staff edit, until the next publish. Duplicate copies the item and its newest lesson right after it, never a learner
 * record. Blocks are data: addresses are https and nothing typed here runs as code.
 */

const TYPE_WORDS: Record<AcademyLessonBlockType, string> = { text: 'Text', image: 'Image', audio: 'Audio', pdf: 'PDF', code: 'Code' };

/** The editor's working copy: every field a string, so a block can change type without losing what was typed. */
type Draft = { type: AcademyLessonBlockType; text: string; url: string; words: string; language: string };

const draftOf = (b: AcademyLessonBlock): Draft => {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.markdown, url: '', words: '', language: '' };
    case 'image':
      return { type: 'image', text: '', url: b.url, words: b.alt, language: '' };
    case 'audio':
    case 'pdf':
      return { type: b.type, text: '', url: b.url, words: b.title, language: '' };
    case 'code':
      return { type: 'code', text: b.source, url: '', words: '', language: b.language };
  }
};

/** What the service takes for each block type; svc-academy checks it again. */
export const blockOf = (d: Draft): AcademyLessonBlock => {
  switch (d.type) {
    case 'text':
      return { type: 'text', markdown: d.text };
    case 'image':
      return { type: 'image', url: d.url.trim(), alt: d.words };
    case 'audio':
      return { type: 'audio', url: d.url.trim(), title: d.words };
    case 'pdf':
      return { type: 'pdf', url: d.url.trim(), title: d.words };
    case 'code':
      return { type: 'code', language: d.language.trim(), source: d.text };
  }
};

/** A lesson as a learner reads it: text as written, media by its https address, code as code. */
function Blocks({ blocks, testId }: { blocks: readonly AcademyLessonBlock[]; testId: string }) {
  return (
    <div className="dk-stack" data-testid={testId}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            return (
              <p key={i} style={{ whiteSpace: 'pre-wrap' }}>
                {b.markdown}
              </p>
            );
          case 'image':
            // eslint-disable-next-line @next/next/no-img-element -- an https address staff typed, shown as it is
            return <img key={i} src={b.url} alt={b.alt} width={320} referrerPolicy="no-referrer" />;
          case 'audio':
            return (
              <figure key={i}>
                <figcaption>{b.title}</figcaption>
                <audio controls src={b.url} preload="none" />
              </figure>
            );
          case 'pdf':
            return (
              <p key={i}>
                <a href={b.url} target="_blank" rel="noreferrer noopener">
                  {b.title} (PDF)
                </a>
              </p>
            );
          case 'code':
            return (
              <pre key={i} data-language={b.language}>
                <code>{b.source}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}

function BlocksEditor({ lesson, busy, onSave }: { lesson: AcademyLesson; busy: boolean; onSave: (blocks: AcademyLessonBlock[]) => void }) {
  const newest = lesson.revisions[0];
  const [blocks, setBlocks] = useState<Draft[]>(() => (newest ? newest.blocks.map(draftOf) : []));
  const [adding, setAdding] = useState<AcademyLessonBlockType>('text');
  const set = (i: number, patch: Partial<Draft>) => setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <section className="dk-stack" aria-labelledby="h-lesson-write">
      <h2 id="h-lesson-write">Write</h2>
      <p className="dk-muted">
        {newest ? `Editing from revision ${newest.revision}.` : 'Nothing is written yet.'} Saving makes a new revision; learners keep the
        published one until you publish again.
      </p>
      <ol className="dk-stack" data-testid="lesson-blocks">
        {blocks.map((b, i) => {
          const name = `Block ${i + 1}`;
          return (
            <li key={i} className="dk-stack" data-testid={`lesson-block-${i}`}>
              <div className="dk-row">
                <select
                  aria-label={`${name} type`}
                  value={b.type}
                  onChange={(e) => set(i, { type: e.target.value as AcademyLessonBlockType })}
                >
                  {ACADEMY_LESSON_BLOCK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_WORDS[t]}
                    </option>
                  ))}
                </select>
                <button type="button" className="adm-btn" aria-label={`Move ${name} up`} onClick={() => setBlocks(move(blocks, i, i - 1))}>
                  Up
                </button>
                <button
                  type="button"
                  className="adm-btn"
                  aria-label={`Move ${name} down`}
                  onClick={() => setBlocks(move(blocks, i, i + 1))}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="adm-btn"
                  aria-label={`Remove ${name}`}
                  onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
              {(b.type === 'text' || b.type === 'code') && (
                <textarea
                  aria-label={`${name} ${b.type === 'text' ? 'text' : 'code'}`}
                  rows={b.type === 'text' ? 5 : 8}
                  maxLength={20_000}
                  value={b.text}
                  onChange={(e) => set(i, { text: e.target.value })}
                  style={b.type === 'code' ? { fontFamily: 'monospace' } : undefined}
                />
              )}
              {b.type === 'code' && (
                <input
                  aria-label={`${name} language`}
                  value={b.language}
                  maxLength={20}
                  placeholder="python"
                  onChange={(e) => set(i, { language: e.target.value })}
                />
              )}
              {(b.type === 'image' || b.type === 'audio' || b.type === 'pdf') && (
                <>
                  <input
                    aria-label={`${name} address`}
                    value={b.url}
                    placeholder="https://"
                    onChange={(e) => set(i, { url: e.target.value })}
                  />
                  <input
                    aria-label={`${name} ${b.type === 'image' ? 'alt text' : 'title'}`}
                    value={b.words}
                    maxLength={200}
                    onChange={(e) => set(i, { words: e.target.value })}
                  />
                </>
              )}
            </li>
          );
        })}
      </ol>
      <div className="dk-row">
        <select aria-label="New block type" value={adding} onChange={(e) => setAdding(e.target.value as AcademyLessonBlockType)}>
          {ACADEMY_LESSON_BLOCK_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_WORDS[t]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="adm-btn"
          onClick={() => setBlocks([...blocks, { type: adding, text: '', url: '', words: '', language: '' }])}
        >
          Add block
        </button>
      </div>
      <button type="button" className="adm-btn" disabled={busy || blocks.length === 0} onClick={() => onSave(blocks.map(blockOf))}>
        {busy ? 'Saving…' : 'Save lesson'}
      </button>
    </section>
  );
}

const SOURCE_WORDS = {
  saved: 'saved',
  reverted: 'reverted',
  duplicated: 'duplicated',
  imported: 'imported',
  assisted: 'accepted from an assistant draft',
} as const;

/**
 * The authoring assistant: a template draft from the course's own structure, or the model path, which waits for the
 * owner to choose a provider. A draft is shown beside nothing live; only Accept writes a revision, and learners still
 * see the published one until the next publish.
 */
function AssistantPanel({ lesson, busy, send }: { lesson: AcademyLesson; busy: boolean; send: (body: Record<string, unknown>) => void }) {
  const revision = lesson.revisions[0]?.revision ?? 0;
  const draft = lesson.draft;
  return (
    <section className="dk-stack" aria-labelledby="h-lesson-assistant">
      <h2 id="h-lesson-assistant">Draft with the assistant</h2>
      <p className="dk-muted">
        The template drafts headings from this course’s own structure for you to fill in. Drafting with a model waits for an owner decision
        on which provider to use. A draft never reaches learners: accepting it makes a new revision, and learners keep the published one
        until you publish again.
      </p>
      <div className="dk-row">
        <button type="button" className="adm-btn" disabled={busy} onClick={() => send({ op: 'draft', revision, path: 'template' })}>
          Draft from the template
        </button>
        <button type="button" className="adm-btn" disabled={busy} onClick={() => send({ op: 'draft', revision, path: 'model' })}>
          Draft with a model
        </button>
      </div>
      {draft ? (
        <div className="dk-stack" data-testid="lesson-draft">
          <p>
            <Chip tone="info">Draft, not live</Chip> From the template, based on revision {draft.basedOnRevision},{' '}
            {formatWhen(draft.createdAt)}.
          </p>
          <Blocks blocks={draft.blocks} testId="lesson-draft-blocks" />
          <div className="dk-row">
            <button
              type="button"
              className="adm-btn"
              disabled={busy}
              onClick={() => send({ op: 'decide', basedOnRevision: draft.basedOnRevision, kind: draft.kind, decision: 'accept' })}
            >
              Accept draft
            </button>
            <button
              type="button"
              className="adm-btn"
              disabled={busy}
              onClick={() => send({ op: 'decide', basedOnRevision: draft.basedOnRevision, kind: draft.kind, decision: 'discard' })}
            >
              Discard draft
            </button>
          </div>
        </div>
      ) : (
        <p className="dk-muted" data-testid="lesson-draft">
          No draft is waiting.
        </p>
      )}
    </section>
  );
}

/**
 * The Learn hub (AC-articles-01): a lesson learners can read may be the hub's featured article. Withdrawing it from
 * learners takes it off the hub in the same step.
 */
function LearnHubPanel({ lesson, busy, send }: { lesson: AcademyLesson; busy: boolean; send: (body: Record<string, unknown>) => void }) {
  const [featureWhy, setFeatureWhy] = useState('');
  const [withdrawWhy, setWithdrawWhy] = useState('');
  const live = lesson.item.liveRevision !== null;
  return (
    <section className="dk-stack" aria-labelledby="h-lesson-hub">
      <h2 id="h-lesson-hub">Learn hub</h2>
      <p className="dk-muted" data-testid="lesson-featured">
        {lesson.featured
          ? 'This lesson is the Learn hub’s featured article.'
          : live
            ? 'Not featured. Learners can read it, so it can be featured.'
            : 'Not featured. Only a lesson learners can read is featured.'}
      </p>
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          send({ op: 'feature', reason: featureWhy });
        }}
      >
        <div className="adm-field">
          <label htmlFor="lesson-feature-reason">Why feature it</label>
          <input id="lesson-feature-reason" value={featureWhy} maxLength={500} onChange={(e) => setFeatureWhy(e.target.value)} />
        </div>
        <button type="submit" className="adm-btn" disabled={busy || lesson.featured}>
          Feature on the Learn hub
        </button>
      </form>
      <form
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          send({ op: 'withdraw', courseRevision: lesson.courseRevision, reason: withdrawWhy });
        }}
      >
        <div className="adm-field">
          <label htmlFor="lesson-withdraw-reason">Why withdraw it</label>
          <input id="lesson-withdraw-reason" value={withdrawWhy} maxLength={500} onChange={(e) => setWithdrawWhy(e.target.value)} />
        </div>
        <button type="submit" className="adm-btn" disabled={busy || !live}>
          Withdraw from learners
        </button>
      </form>
    </section>
  );
}

/** The import's report: every block svc-academy did not accept, by its place in the file. */
function ImportReport({ reply }: { reply: LessonDeskReply | null }) {
  if (!reply || reply.ok || !reply.problems) return null;
  return (
    <ul className="dk-stack" data-testid="lesson-import-report">
      {reply.problems.map((p, i) => (
        <li key={i}>
          {p.block === null ? 'The file' : `Block ${p.block}`}: {p.problem}
        </li>
      ))}
    </ul>
  );
}

/**
 * A lesson file is checked against the owner's size limit before a byte of it is read or sent; svc-academy checks the
 * size again before parsing it.
 */
function ImportForm({
  lesson,
  busy,
  onImport,
  onRefused,
}: {
  lesson: AcademyLesson;
  busy: boolean;
  onImport: (document: string) => void;
  onRefused: (reply: LessonDeskReply) => void;
}) {
  // Read from the input when pressed, so a file chosen before the page was interactive still counts.
  const input = useRef<HTMLInputElement>(null);
  const max = lesson.importMaxBytes;
  const submit = async () => {
    const file = input.current?.files?.[0];
    if (!file) return;
    if (max === null) return onRefused({ ok: false, ...explainRefusal('academy.import_limit_unset', 412) });
    if (file.size > max) return onRefused({ ok: false, ...explainRefusal('academy.import_too_large', 400) });
    onImport(await file.text());
  };
  return (
    <section className="dk-stack" aria-labelledby="h-lesson-import">
      <h2 id="h-lesson-import">Import</h2>
      <p className="dk-muted" data-testid="lesson-import-limit">
        A <code>{ACADEMY_LESSON_FORMAT}</code> file: <code>{'{ "format": "' + ACADEMY_LESSON_FORMAT + '", "blocks": [...] }'}</code>.{' '}
        {max === null ? 'The owner has not set the size limit, so nothing is imported.' : `Up to ${max} bytes.`} It becomes a new revision;
        learners keep the published one.
      </p>
      <div className="dk-row">
        <label htmlFor="lesson-import-file">Lesson file</label>
        <input id="lesson-import-file" ref={input} type="file" accept="application/json,.json" />
        <button type="button" className="adm-btn" disabled={busy} onClick={() => void submit()}>
          Import file
        </button>
      </div>
    </section>
  );
}

export function AcademyLessonEditor({
  courseId,
  itemId,
  initial,
  brief,
  files,
}: {
  courseId: string;
  itemId: string;
  initial: LessonView | null;
  /** An assignment item's brief (AC-assignments-01), shown before the lesson. */
  brief?: ReactNode;
  /** The item's video, captions and handouts (AC-videos-02), shown after the import. */
  files?: ReactNode;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<LessonDeskReply | null>(null);
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<number | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchLesson(itemId);
    if (next) setView(next);
  }, [itemId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postLessonChange({ itemId, ...body });
    setReply(answer);
    setBusy(false);
    if (answer.ok && body.op === 'duplicate') {
      router.push(`/academy-ops/catalogue/courses/${courseId}/items/${answer.lesson.item.id}`);
      return;
    }
    // Whatever the answer, the page shows the lesson as svc-academy holds it now.
    await reload();
  };

  const part = view?.lesson;
  const lesson = part?.kind === 'ok' ? part.data : null;
  const live = lesson ? liveOf(lesson) : null;
  const newest = lesson?.revisions[0] ?? null;
  const viewing = lesson?.revisions.find((r) => r.revision === shown) ?? null;
  return (
    <div className="dk" data-testid="academy-lesson">
      <div className="adm-pagehead">
        <div>
          <h1>{lesson?.item.title ?? 'Lesson'}</h1>
          <p>
            <Link href={`/academy-ops/catalogue/courses/${courseId}`}>
              {lesson ? `Back to ${lesson.courseTitle}` : 'Back to the course'}
            </Link>
          </p>
        </div>
      </div>
      <AcademyNav />
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={() => void reload()}>
          Refresh
        </button>
        <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      </div>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server for this editor. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read this lesson" message={part.message} code={part.code} />}
      {brief}
      {lesson && (
        <>
          <dl className="dk-kv" data-testid="lesson-facts">
            <dt>Type</dt>
            <dd>{lesson.item.kind}</dd>
            <dt>Newest revision</dt>
            <dd>{newest ? newest.revision : 'None yet'}</dd>
            <dt>Learners see</dt>
            <dd data-testid="lesson-live-revision">{live ? `Revision ${live.revision}` : 'Nothing: no revision is published'}</dd>
          </dl>
          <BlocksEditor
            key={newest?.revision ?? 0}
            lesson={lesson}
            busy={busy}
            onSave={(blocks) => void send({ op: 'save', revision: newest?.revision ?? 0, blocks })}
          />
          <AssistantPanel lesson={lesson} busy={busy} send={(body) => void send(body)} />
          <ImportForm
            lesson={lesson}
            busy={busy}
            onImport={(document) => void send({ op: 'import', revision: newest?.revision ?? 0, document })}
            onRefused={setReply}
          />
          <ImportReport reply={reply} />
          {files}
          <section className="dk-stack" aria-labelledby="h-lesson-live">
            <h2 id="h-lesson-live">What learners see</h2>
            {live ? (
              <Blocks blocks={live.blocks} testId="lesson-live" />
            ) : (
              <p className="dk-muted" data-testid="lesson-live">
                No revision of this lesson is published, so learners see nothing here yet.
              </p>
            )}
            {newest && (
              <form
                className="dk-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ op: 'publish', lessonRevision: newest.revision, courseRevision: lesson.courseRevision, reason });
                }}
              >
                <div className="adm-field">
                  <label htmlFor="lesson-publish-reason">Reason</label>
                  <input id="lesson-publish-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                </div>
                <button type="submit" className="adm-btn" disabled={busy || newest.revision === lesson.item.liveRevision}>
                  Publish revision {newest.revision} to learners
                </button>
              </form>
            )}
          </section>
          <LearnHubPanel lesson={lesson} busy={busy} send={(body) => void send(body)} />
          <section className="dk-stack" aria-labelledby="h-lesson-revisions">
            <h2 id="h-lesson-revisions">Revisions</h2>
            {lesson.revisions.length === 0 ? (
              <p className="dk-muted">No revision yet. Saving the first one makes revision 1.</p>
            ) : (
              <ol className="dk-stack" data-testid="lesson-revisions">
                {lesson.revisions.map((r) => (
                  <li key={r.revision} className="dk-row" data-testid={`lesson-revision-${r.revision}`}>
                    <span>
                      Revision {r.revision}: {SOURCE_WORDS[r.source]}
                      {r.fromRevision ? ` from revision ${r.fromRevision}` : ''}
                      {r.fromItemId ? ' from another item' : ''} {formatWhen(r.at)} by <code>{r.actor}</code>
                    </span>
                    {r.revision === lesson.item.liveRevision && <Chip tone="live">Learners see this</Chip>}
                    <button type="button" className="adm-btn" onClick={() => setShown(shown === r.revision ? null : r.revision)}>
                      {shown === r.revision ? `Hide revision ${r.revision}` : `View revision ${r.revision}`}
                    </button>
                    {newest && r.revision !== newest.revision && (
                      <button
                        type="button"
                        className="adm-btn"
                        disabled={busy}
                        onClick={() => void send({ op: 'revert', revision: newest.revision, toRevision: r.revision })}
                      >
                        Revert to revision {r.revision}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {viewing && <Blocks blocks={viewing.blocks} testId="lesson-revision-view" />}
          </section>
          <section className="dk-stack" aria-labelledby="h-lesson-duplicate">
            <h2 id="h-lesson-duplicate">Duplicate</h2>
            <p className="dk-muted">
              Copies this item and its newest lesson right after it, as a new revision 1 that learners do not see until it is published.
              Enrolments, progress and attempts are kept per learner, never on an item, so none is copied. Only a draft course’s outline
              changes.
            </p>
            <button
              type="button"
              className="adm-btn"
              disabled={busy || lesson.courseState !== 'draft'}
              onClick={() => void send({ op: 'duplicate', courseRevision: lesson.courseRevision })}
            >
              Duplicate this item
            </button>
          </section>
        </>
      )}
    </div>
  );
}
