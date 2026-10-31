'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchHub, postHubChange } from '@/lib/academy/hub-browser';
import type { HubDeskReply, HubView } from '@/lib/academy/hub-model';
import { AcademyNav, Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * LEARN HUB DESK (AC-articles-01).
 *
 * The hub has one featured slot. It holds a course lesson learners can read, chosen from the lesson's own page with a
 * reason (it leaves the slot when the lesson is withdrawn from learners), or a curriculum article; either replaces the
 * other, and Clear empties it whichever it holds. Nothing is promoted automatically. Topics are names staff own,
 * each with an address that is never one of the Academy's tabs; courses are filed under them on the course page.
 */
export function AcademyLearnHub({ initial }: { initial: HubView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<HubDeskReply | null>(null);
  const [clearWhy, setClearWhy] = useState('');
  const [itemSlug, setItemSlug] = useState('');
  const [itemWhy, setItemWhy] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  const reload = useCallback(async () => {
    const next = await fetchHub();
    if (next) setView(next);
  }, []);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postHubChange(body);
    setReply(answer);
    setBusy(false);
    if (answer.ok && body.op === 'topic') {
      setName('');
      setSlug('');
    }
    // Whatever the answer, the desk shows what svc-academy holds now.
    await reload();
  };

  const slot = view?.slot;
  const topics = view?.topics;
  const lesson = slot?.kind === 'ok' ? slot.data.lesson : null;
  const curriculum = slot?.kind === 'ok' ? slot.data.curriculum : null;
  return (
    <div className="dk" data-testid="academy-learn-hub">
      <div className="adm-pagehead">
        <div>
          <h1>Academy: Learn hub</h1>
          <p>
            <Link href="/academy-ops/catalogue">Back to the catalogue</Link>
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
      {!view && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      <section className="dk-stack" aria-labelledby="h-hub-featured">
        <h2 id="h-hub-featured">Featured article</h2>
        {slot?.kind === 'failed' && <Failed title="Could not read the featured slot" message={slot.message} code={slot.code} />}
        {slot?.kind === 'ok' && (
          <>
            {lesson ? (
              <div className="dk-stack" data-testid="hub-featured">
                <p>
                  <Link href={`/academy-ops/catalogue/courses/${lesson.courseId}/items/${lesson.itemId}`}>{lesson.title}</Link> in{' '}
                  {lesson.courseTitle}{' '}
                  <Chip tone={lesson.courseState === 'published' ? 'live' : 'neutral'}>Course {lesson.courseState}</Chip>
                </p>
                <p className="dk-muted">
                  Learners read revision {lesson.liveRevision}. Chosen {slot.data.chosenAt ? formatWhen(slot.data.chosenAt) : ''} by{' '}
                  <code>{slot.data.chosenBy}</code>: {slot.data.reason}
                </p>
              </div>
            ) : curriculum ? (
              <div className="dk-stack" data-testid="hub-featured">
                <p>
                  The curriculum article <strong>{curriculum.title}</strong> <code>{curriculum.slug}</code>
                </p>
                <p className="dk-muted">
                  Chosen {slot.data.chosenAt ? formatWhen(slot.data.chosenAt) : ''} by <code>{slot.data.chosenBy}</code>: {slot.data.reason}
                </p>
              </div>
            ) : (
              <p className="dk-muted" data-testid="hub-featured">
                Nothing is featured. Feature a lesson learners can read from that lesson’s page.
              </p>
            )}
            <form
              className="dk-row"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ op: 'clear', reason: clearWhy });
              }}
            >
              <div className="adm-field">
                <label htmlFor="hub-clear-reason">Why clear it</label>
                <input id="hub-clear-reason" value={clearWhy} maxLength={500} onChange={(e) => setClearWhy(e.target.value)} />
              </div>
              <button type="submit" className="adm-btn" disabled={busy || (!lesson && !curriculum)}>
                Clear the featured slot
              </button>
            </form>
            <form
              className="dk-row"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ op: 'item', itemSlug, reason: itemWhy });
              }}
            >
              <div className="adm-field">
                <label htmlFor="hub-item-slug">Article address</label>
                <input id="hub-item-slug" value={itemSlug} maxLength={120} onChange={(e) => setItemSlug(e.target.value)} />
              </div>
              <div className="adm-field">
                <label htmlFor="hub-item-reason">Why feature the article</label>
                <input id="hub-item-reason" value={itemWhy} maxLength={500} onChange={(e) => setItemWhy(e.target.value)} />
              </div>
              <button type="submit" className="adm-btn" disabled={busy}>
                Feature the article
              </button>
            </form>
          </>
        )}
      </section>
      <section className="dk-stack" aria-labelledby="h-hub-topics">
        <h2 id="h-hub-topics">Topics</h2>
        {topics?.kind === 'failed' && <Failed title="Could not read the topics" message={topics.message} code={topics.code} />}
        {topics?.kind === 'ok' &&
          (topics.data.topics.length === 0 ? (
            <p className="dk-muted" data-testid="hub-topics">
              No topics yet.
            </p>
          ) : (
            <>
              <p className="dk-muted">Newest first, up to {topics.data.limit} (the owner’s list limit).</p>
              <ul className="dk-stack" data-testid="hub-topics">
                {topics.data.topics.map((t) => (
                  <li key={t.id}>
                    {t.name} <code>{t.slug}</code>, added {formatWhen(t.createdAt)}
                  </li>
                ))}
              </ul>
            </>
          ))}
        <form
          className="dk-row"
          onSubmit={(e) => {
            e.preventDefault();
            void send({ op: 'topic', name, slug });
          }}
        >
          <div className="adm-field">
            <label htmlFor="hub-topic-name">Topic name</label>
            <input id="hub-topic-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="adm-field">
            <label htmlFor="hub-topic-slug">Topic address</label>
            <input id="hub-topic-slug" value={slug} maxLength={64} onChange={(e) => setSlug(e.target.value)} />
          </div>
          <button type="submit" className="adm-btn" disabled={busy}>
            Add topic
          </button>
        </form>
      </section>
    </div>
  );
}
