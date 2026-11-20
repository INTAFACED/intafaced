import { describe, expect, it } from 'vitest';
import { itemType, listCurriculum } from './catalog.js';

describe('itemType (AC-course-structure-02)', () => {
  it('a published quiz makes any item a quiz; a workbook is an assignment; a playbook or lesson is a lesson', () => {
    expect(itemType('playbook', false)).toBe('lesson');
    expect(itemType('lesson', false)).toBe('lesson');
    expect(itemType('workbook', false)).toBe('assignment');
    expect(itemType('playbook', true)).toBe('quiz');
    expect(itemType('workbook', true)).toBe('quiz');
  });

  it('the built-in courses hold lessons and their workbooks as assignments, and no quiz until one is published', () => {
    const types = (path: 'foundations' | 'markets' | 'builder' | 'sovereign') =>
      [...new Set(listCurriculum({ path }).map((row) => itemType(row.kind, false)))].sort();
    for (const path of ['foundations', 'markets', 'builder'] as const) expect(types(path)).toEqual(['assignment', 'lesson']);
    expect(types('sovereign')).toEqual(['lesson']);
  });
});
