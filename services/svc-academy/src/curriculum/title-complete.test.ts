import { describe, expect, it } from 'vitest';
import { getCurriculumItem, listCurriculum } from './catalog.js';

/**
 * A title ends mid-word when it is cut on a hyphen or comma, or its last token
 * has no vowel (a clipped stem such as "inv"). A dangling function word
 * ("without", "of") is the same cut one word earlier.
 */
const DANGLING_LAST_WORD = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'of',
  'to',
  'for',
  'with',
  'without',
  'in',
  'on',
  'at',
  'by',
  'from',
  'into',
  'over',
  'than',
  'as',
]);

export function titleEndsMidWord(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed || /[-–—/,;:…]$/.test(trimmed)) return true;
  const last =
    trimmed
      .split(/\s+/)
      .at(-1)
      ?.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '') ?? '';
  if (last.length < 2) return true;
  if (!/[aeiouy]/i.test(last)) return true;
  if (DANGLING_LAST_WORD.has(last.toLowerCase())) return true;
  return false;
}

describe('curriculum titles are complete words', () => {
  it('completes the position-sizing title', () => {
    const item = getCurriculumItem('foundations-position-sizing');
    expect(item?.title).toBe('Position sizing without inventing numbers');
    const heading = item?.body.trimStart().split('\n', 1)[0];
    expect(heading).toBe('# Position sizing without inventing numbers');
  });

  it('does not end any curriculum title mid-word', () => {
    for (const summary of listCurriculum()) {
      const item = getCurriculumItem(summary.slug);
      expect(item, summary.slug).toBeDefined();
      expect(titleEndsMidWord(item!.title), item!.title).toBe(false);
      const heading = item!.body.trimStart().split('\n', 1)[0]?.replace(/^#\s+/, '').trim();
      expect(heading, summary.slug).toBe(item!.title);
    }
  });
});
