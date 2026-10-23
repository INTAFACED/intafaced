'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ACADEMY_ITEMS_WITHOUT_LESSON,
  ACADEMY_OUTLINE_ITEM_KINDS,
  type AcademyOutlineItemKind,
} from '@intafaced/contracts/academy-courses';
import type { AcademyCourseDetail } from '@/lib/academy/courses-model';

/**
 * COURSE OUTLINE EDITOR (AC-course-structure-02).
 *
 * Sections of typed items, in order, with an indent of 0 to 2. The whole outline is saved at once over the revision the
 * page read; svc-academy refuses while the owner's section and item limits are blank, and past them. A published course's
 * outline is shown, not edited here. A stored item keeps its id, so its lesson (AC-course-structure-03) survives reordering
 * and renaming; removing the item and saving deletes its lesson with it.
 */

/** `id` is the stored item's or section's: it keeps an item's lesson across saves. A new one has none until saved. */
type Item = {
  id?: string;
  kind: AcademyOutlineItemKind;
  title: string;
  indent: number;
  url: string;
  lessonRevision: number | null;
  liveRevision: number | null;
};
type Section = { id?: string; title: string; items: Item[] };

const KIND_WORDS: Record<AcademyOutlineItemKind, string> = {
  lesson: 'Lesson',
  video: 'Video',
  file: 'File',
  quiz: 'Quiz',
  assignment: 'Assignment',
  discussion: 'Discussion',
  link: 'Link',
  subheader: 'Subheader',
};

const fromDetail = (d: AcademyCourseDetail): Section[] =>
  d.outline.map((s) => ({
    id: s.id,
    title: s.title,
    items: s.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      indent: i.indent,
      url: i.url ?? '',
      lessonRevision: i.lessonRevision,
      liveRevision: i.liveRevision,
    })),
  }));

/** What the service takes: a link keeps its address, every other kind sends none. */
export const outlineBody = (sections: readonly Section[]) =>
  sections.map((s) => ({
    ...(s.id ? { id: s.id } : {}),
    title: s.title.trim(),
    items: s.items.map((i) => ({
      ...(i.id ? { id: i.id } : {}),
      kind: i.kind,
      title: i.title.trim(),
      indent: i.indent,
      url: i.kind === 'link' ? i.url.trim() : null,
    })),
  }));

/** Where an item's lesson is written, and what learners see of it. Only a saved item that holds a lesson has one. */
function LessonLink({ courseId, item, name }: { courseId: string; item: Item; name: string }) {
  if (!item.id || (ACADEMY_ITEMS_WITHOUT_LESSON as readonly string[]).includes(item.kind)) return null;
  const state =
    item.lessonRevision === null
      ? 'nothing written'
      : item.liveRevision === null
        ? `revision ${item.lessonRevision}, not published`
        : `revision ${item.lessonRevision}, learners see ${item.liveRevision}`;
  return (
    <span className="dk-muted">
      <Link href={`/academy-ops/catalogue/courses/${courseId}/items/${item.id}`} aria-label={`Write ${name}`}>
        Write
      </Link>{' '}
      ({state})
    </span>
  );
}

/** One entry moved from `from` to `to`; out of range leaves the list as it is. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [one] = next.splice(from, 1);
  next.splice(to, 0, one!);
  return next;
}

function LimitsLine({ limits }: { limits: AcademyCourseDetail['limits'] }) {
  const show = (n: number | null) => (n === null ? 'not set' : String(n));
  return (
    <p className="dk-muted" data-testid="outline-limits">
      Owner limits: sections {show(limits.maxSections)}, items {show(limits.maxItems)}.
      {(limits.maxSections === null || limits.maxItems === null) && ' An outline is not saved until both are set.'}
    </p>
  );
}

export function OutlineEditor({
  detail,
  busy,
  onSave,
}: {
  detail: AcademyCourseDetail;
  busy: boolean;
  onSave: (sections: ReturnType<typeof outlineBody>) => void;
}) {
  const [sections, setSections] = useState<Section[]>(() => fromDetail(detail));
  const [newSection, setNewSection] = useState('');
  const editable = detail.course.state === 'draft';
  const setSection = (si: number, next: Section) => setSections(sections.map((s, i) => (i === si ? next : s)));
  const setItem = (si: number, ii: number, patch: Partial<Item>) =>
    setSection(si, { ...sections[si]!, items: sections[si]!.items.map((it, i) => (i === ii ? { ...it, ...patch } : it)) });

  if (!editable)
    return (
      <section className="dk-stack" aria-labelledby="h-outline">
        <h2 id="h-outline">Outline</h2>
        <ol className="dk-stack" data-testid="outline">
          {detail.outline.map((s) => (
            <li key={s.id}>
              <strong>{s.title}</strong>
              <ol>
                {s.items.map((i) => (
                  <li key={i.id} style={{ marginLeft: `${i.indent * 16}px` }}>
                    {KIND_WORDS[i.kind]}: {i.title}{' '}
                    <LessonLink courseId={detail.course.id} item={{ ...i, url: i.url ?? '' }} name={i.title} />
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </section>
    );

  return (
    <section className="dk-stack" aria-labelledby="h-outline">
      <h2 id="h-outline">Outline</h2>
      <LimitsLine limits={detail.limits} />
      {sections.length === 0 && <p className="dk-muted">No sections yet. Add the first one below.</p>}
      <ol className="dk-stack" data-testid="outline">
        {sections.map((section, si) => (
          <li key={si} className="dk-stack" data-testid={`outline-section-${si}`}>
            <div className="dk-row">
              <label htmlFor={`section-${si}-title`}>Section {si + 1}</label>
              <input
                id={`section-${si}-title`}
                value={section.title}
                maxLength={120}
                onChange={(e) => setSection(si, { ...section, title: e.target.value })}
              />
              <button
                type="button"
                className="adm-btn"
                onClick={() => setSections(move(sections, si, si - 1))}
                aria-label={`Move section ${si + 1} up`}
              >
                Up
              </button>
              <button
                type="button"
                className="adm-btn"
                onClick={() => setSections(move(sections, si, si + 1))}
                aria-label={`Move section ${si + 1} down`}
              >
                Down
              </button>
              <button
                type="button"
                className="adm-btn"
                onClick={() => setSections(sections.filter((_, i) => i !== si))}
                aria-label={`Remove section ${si + 1}`}
              >
                Remove
              </button>
            </div>
            <ol className="dk-stack">
              {section.items.map((item, ii) => {
                const name = `Section ${si + 1} item ${ii + 1}`;
                return (
                  <li key={ii} className="dk-row" style={{ marginLeft: `${item.indent * 24}px` }} data-testid={`outline-item-${si}-${ii}`}>
                    <select
                      aria-label={`${name} type`}
                      value={item.kind}
                      onChange={(e) => setItem(si, ii, { kind: e.target.value as AcademyOutlineItemKind })}
                    >
                      {ACADEMY_OUTLINE_ITEM_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_WORDS[k]}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`${name} title`}
                      value={item.title}
                      maxLength={120}
                      onChange={(e) => setItem(si, ii, { title: e.target.value })}
                    />
                    {item.kind === 'link' && (
                      <input
                        aria-label={`${name} address`}
                        value={item.url}
                        placeholder="https://"
                        onChange={(e) => setItem(si, ii, { url: e.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => setItem(si, ii, { indent: Math.max(0, item.indent - 1) })}
                      aria-label={`Outdent ${name}`}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => setItem(si, ii, { indent: Math.min(2, item.indent + 1) })}
                      aria-label={`Indent ${name}`}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => setSection(si, { ...section, items: move(section.items, ii, ii - 1) })}
                      aria-label={`Move ${name} up`}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => setSection(si, { ...section, items: move(section.items, ii, ii + 1) })}
                      aria-label={`Move ${name} down`}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="adm-btn"
                      onClick={() => setSection(si, { ...section, items: section.items.filter((_, i) => i !== ii) })}
                      aria-label={`Remove ${name}`}
                    >
                      Remove
                    </button>
                    <LessonLink courseId={detail.course.id} item={item} name={name} />
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              className="adm-btn"
              onClick={() =>
                setSection(si, {
                  ...section,
                  items: [...section.items, { kind: 'lesson', title: '', indent: 0, url: '', lessonRevision: null, liveRevision: null }],
                })
              }
            >
              Add item to section {si + 1}
            </button>
          </li>
        ))}
      </ol>
      <div className="dk-row">
        <label htmlFor="new-section-title">New section</label>
        <input id="new-section-title" value={newSection} maxLength={120} onChange={(e) => setNewSection(e.target.value)} />
        <button
          type="button"
          className="adm-btn"
          disabled={newSection.trim() === ''}
          onClick={() => {
            setSections([...sections, { title: newSection.trim(), items: [] }]);
            setNewSection('');
          }}
        >
          Add section
        </button>
      </div>
      <button type="button" className="adm-btn" disabled={busy} onClick={() => onSave(outlineBody(sections))}>
        {busy ? 'Saving…' : 'Save outline'}
      </button>
    </section>
  );
}
