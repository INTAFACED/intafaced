import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AcademyLearnerDesk } from './academy-learner-desk';
import type { LearnerView } from '@/lib/academy/learners-model';

// intafaced#9661: J-academy-14 #1 typed a note into the served HTML before React attached, so the form's state stayed
// empty and Save sent no note ("Write the note."). The served page keeps every control disabled until React runs it.
const USER = '11111111-1111-4111-8111-111111111111';
const view: LearnerView = {
  userId: USER,
  asOf: '2026-11-22T00:00:00.000Z',
  card: { kind: 'failed', message: 'TEST', code: null, notBuilt: false, forbidden: false },
  page: {
    kind: 'ok',
    data: { userId: USER, canChange: true, access: [], enrolments: [], notes: [], tags: [], audit: [] },
  },
  progress: { kind: 'failed', message: 'TEST', code: null, notBuilt: false, forbidden: false },
};

describe('learner page before hydration (J-academy-14)', () => {
  it('serves every control inside a disabled fieldset, so nothing can be typed or sent before React runs the page', () => {
    const html = renderToStaticMarkup(<AcademyLearnerDesk userId={USER} initial={view} />);
    const open = html.match(/<fieldset[^>]*data-testid="learner-controls"[^>]*>/)?.[0];
    expect(open, html.slice(0, 400)).toBeDefined();
    expect(open).toMatch(/\sdisabled=""/);
    const inside = html.slice(html.indexOf(open!), html.lastIndexOf('</fieldset>'));
    expect(inside).toContain('aria-label="Internal note"');
    expect(inside).toContain('Save note');
    expect(inside).toContain('aria-label="Add a tag"');
    expect(inside).toContain('aria-label="Grant access"');
  });
});
