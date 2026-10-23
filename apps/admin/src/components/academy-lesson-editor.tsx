'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { ACADEMY_LESSON_BLOCK_TYPES, type AcademyLessonBlockType } from '@intafaced/contracts/academy-courses';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchLesson, postLessonChange } from '@/lib/academy/lessons-browser';
import { liveOf, type AcademyLesson, type AcademyLessonBlock, type LessonDeskReply, type LessonView } from '@/lib/academy/lessons-model';
import { AcademyNav, Failed, Outcome } from '@/components/academy-courses-desk';

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

function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [one] = next.splice(from, 1);
  next.splice(to, 0, one!);
  return next;
}

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

const SOURCE_WORDS = { saved: 'saved', reverted: 'reverted', duplicated: 'duplicated' } as const;

export function AcademyLessonEditor({ courseId, itemId, initial }: { courseId: string; itemId: string; initial: LessonView | null }) {
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
