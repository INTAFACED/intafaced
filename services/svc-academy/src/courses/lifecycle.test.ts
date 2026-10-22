import { describe, expect, it } from 'vitest';
import { AcademyError } from '../errors.js';
import { assertCourseSlug, decideMove, learnerAccess, parseCoursePrice, RESERVED_SLUGS, type CourseSnapshot } from './lifecycle.js';

const NOW = new Date('2026-10-22T00:00:00.000Z');
const base: CourseSnapshot = { state: 'draft', stateBeforeDelete: null, priceChoice: 'free', price: null, deletedAt: null };
const ctx = { undeleteWindowSeconds: 60, now: NOW };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AcademyError ? err.code : 'not-academy';
  }
  return undefined;
}

describe('course slug', () => {
  it.each(RESERVED_SLUGS)('reserved %s refuses academy.slug_reserved', (slug) => {
    expect(code(() => assertCourseSlug(slug))).toBe('academy.slug_reserved');
  });
  it('malformed slug refuses academy.course_invalid', () => {
    expect(code(() => assertCourseSlug('Bad Slug'))).toBe('academy.course_invalid');
    expect(code(() => assertCourseSlug('a'.repeat(97)))).toBe('academy.course_invalid');
  });
  it('good slug passes', () => {
    expect(code(() => assertCourseSlug('intro-to-markets'))).toBeUndefined();
  });
});

describe('course price', () => {
  it('blank is null (not set), never defaulted', () => {
    expect(parseCoursePrice('paid', null)).toBeNull();
    expect(parseCoursePrice('paid', ' ')).toBeNull();
    expect(parseCoursePrice('free', undefined)).toBeNull();
  });
  it('parses to scaled bigint', () => {
    expect(typeof parseCoursePrice('paid', '12.5')).toBe('bigint');
  });
  it('free with a price, zero, negative and garbage refuse academy.course_invalid', () => {
    expect(code(() => parseCoursePrice('free', '1'))).toBe('academy.course_invalid');
    expect(code(() => parseCoursePrice('paid', '0'))).toBe('academy.course_invalid');
    expect(code(() => parseCoursePrice('paid', '-1'))).toBe('academy.course_invalid');
    expect(code(() => parseCoursePrice('paid', 'abc'))).toBe('academy.course_invalid');
  });
});

describe('decideMove', () => {
  it('walks draft → published → concluded → archived', () => {
    expect(decideMove(base, 'publish', ctx)).toBe('published');
    expect(decideMove({ ...base, state: 'published' }, 'conclude', ctx)).toBe('concluded');
    expect(decideMove({ ...base, state: 'concluded' }, 'archive', ctx)).toBe('archived');
  });
  it('out-of-order moves refuse academy.item_transition_illegal', () => {
    expect(code(() => decideMove(base, 'conclude', ctx))).toBe('academy.item_transition_illegal');
    expect(code(() => decideMove(base, 'archive', ctx))).toBe('academy.item_transition_illegal');
    expect(code(() => decideMove({ ...base, state: 'published' }, 'publish', ctx))).toBe('academy.item_transition_illegal');
    expect(code(() => decideMove(base, 'undelete', ctx))).toBe('academy.item_transition_illegal');
  });
  it('paid course without a price refuses academy.price_unset on publish', () => {
    expect(code(() => decideMove({ ...base, priceChoice: 'paid' }, 'publish', ctx))).toBe('academy.price_unset');
    expect(decideMove({ ...base, priceChoice: 'paid', price: 1n }, 'publish', ctx)).toBe('published');
  });
  it('delete and undelete refuse academy.undelete_window_unset when the window is blank', () => {
    const blank = { undeleteWindowSeconds: null, now: NOW };
    expect(code(() => decideMove(base, 'delete', blank))).toBe('academy.undelete_window_unset');
    expect(code(() => decideMove({ ...base, state: 'deleted' }, 'undelete', blank))).toBe('academy.undelete_window_unset');
  });
  it('delete from any live state; deleting twice refuses', () => {
    for (const state of ['draft', 'published', 'concluded', 'archived'] as const) {
      expect(decideMove({ ...base, state }, 'delete', ctx)).toBe('deleted');
    }
    expect(code(() => decideMove({ ...base, state: 'deleted' }, 'delete', ctx))).toBe('academy.item_transition_illegal');
  });
  it('undelete inside the window restores the prior state; outside refuses', () => {
    const deleted: CourseSnapshot = {
      ...base,
      state: 'deleted',
      stateBeforeDelete: 'published',
      deletedAt: new Date(NOW.getTime() - 60_000),
    };
    expect(decideMove(deleted, 'undelete', ctx)).toBe('published');
    const late = { ...deleted, deletedAt: new Date(NOW.getTime() - 60_001) };
    expect(code(() => decideMove(late, 'undelete', ctx))).toBe('academy.item_transition_illegal');
  });
});

describe('learnerAccess', () => {
  it('published is read-write, concluded and archived read-only, draft and deleted none', () => {
    expect(learnerAccess('published')).toBe('read_write');
    expect(learnerAccess('concluded')).toBe('read_only');
    expect(learnerAccess('archived')).toBe('read_only');
    expect(learnerAccess('draft')).toBe('none');
    expect(learnerAccess('deleted')).toBe('none');
  });
});
