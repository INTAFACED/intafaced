'use client';

import { useState } from 'react';
import { ACADEMY_OUTLINE_ITEM_KINDS, type AcademyOutlineItemKind } from '@intafaced/contracts/academy-courses';
import type { AcademyCourseDetail } from '@/lib/academy/courses-model';

/**
 * COURSE OUTLINE EDITOR (AC-course-structure-02).
 *
 * Sections of typed items, in order, with an indent of 0 to 2. The whole outline is saved at once over the revision the
 * page read; svc-academy refuses while the owner's section and item limits are blank, and past them. A published course's
 * outline is shown, not edited here.
 */

type Item = { kind: AcademyOutlineItemKind; title: string; indent: number; url: string };
type Section = { title: string; items: Item[] };

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
    title: s.title,
    items: s.items.map((i) => ({ kind: i.kind, title: i.title, indent: i.indent, url: i.url ?? '' })),
  }));

/** What the service takes: a link keeps its address, every other kind sends none. */
export const outlineBody = (sections: readonly Section[]) =>
  sections.map((s) => ({
    title: s.title.trim(),
    items: s.items.map((i) => ({ kind: i.kind, title: i.title.trim(), indent: i.indent, url: i.kind === 'link' ? i.url.trim() : null })),
  }));

function move<T>(list: readonly T[], from: number, to: number): T[] {
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
                    {KIND_WORDS[i.kind]}: {i.title}
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
                      onClick={() => setSection(si, { ...section, items: section.items.filter((_, i) => i !== ii) })}
                      aria-label={`Remove ${name}`}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              className="adm-btn"
              onClick={() => setSection(si, { ...section, items: [...section.items, { kind: 'lesson', title: '', indent: 0, url: '' }] })}
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
