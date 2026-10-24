import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AcademyReviewState, AcademyReviewTask } from '@intafaced/contracts/academy-courses';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { academyLmsCopy } from './academy-lms-copy';
import { academyRefusalKey } from './academy-flows';
import { ReviewForm, reviewCountLine, reviewFileName } from './AcademyPeerReview';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const t = academyLmsCopy.t;

const TASK: AcademyReviewTask = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  kind: 'peer',
  ordinal: 2,
  text: 'TEST sizes from the stop.',
  file: { fileName: null, contentType: 'application/pdf', bytes: 2048 },
  criteria: [
    { name: 'Sizing', levels: ['0', '1', '2'] },
    { name: 'Working shown', levels: ['0', '0.5'] },
  ],
};
const STATE: AcademyReviewState = {
  itemId: '1f8fad5b-d9cb-469f-a165-70867728950e',
  stage: 'peer',
  peer: true,
  peerCount: 2,
  self: true,
  peerDone: 1,
  selfDone: false,
  task: TASK,
};

describe('peer and self review on an assignment page (AC-assignments-03)', () => {
  it('counts peer reviews done, then says the self review is due, then that all are done', () => {
    expect(reviewCountLine(STATE, t)).toBe('Peer review: 1 of 2 done');
    expect(reviewCountLine({ ...STATE, peer: false, peerCount: null, stage: 'self' }, t)).toBe('Self review to do');
    expect(reviewCountLine({ ...STATE, stage: 'done' }, t)).toBe('Reviews done');
  });

  it('shows a classmate’s work under an alias with one labelled level per criterion, and the file by name only', () => {
    const out = html(<ReviewForm task={TASK} sending={false} onSend={() => undefined} />);
    expect(out).toContain('Classmate 2');
    expect(out).toContain('data-testid="review-work"');
    expect(out).toContain('aria-label="Sizing: 2"');
    expect(out).toContain('aria-label="Working shown: 0.5"');
    expect(out).toContain('A file is handed in with this work (2 KiB).');
    expect(out).toContain('Send review');
    expect(out).not.toContain('href=');
  });

  it('a self review shows the learner’s own work and its own send button', () => {
    const out = html(<ReviewForm task={{ ...TASK, kind: 'self', ordinal: null, file: null }} sending={false} onSend={() => undefined} />);
    expect(out).toContain('data-testid="review-self"');
    expect(out).toContain('Your work');
    expect(out).toContain('Send self review');
  });

  it('opens a classmate’s file under a neutral name, and the learner’s own under its own', () => {
    expect(reviewFileName(TASK, 'application/pdf')).toBe('classmate-2.pdf');
    const own = { ...TASK, kind: 'self' as const, ordinal: null, file: { fileName: 'mine.png', contentType: 'image/png', bytes: 9 } };
    expect(reviewFileName(own, 'image/png')).toBe('mine.png');
    expect(reviewCountLine({ ...STATE, stage: 'off', task: null }, t)).toBe('This assignment has no peer or self review.');
  });

  it('names every review refusal', () => {
    expect(academyRefusalKey({ code: 'academy.review_marks_invalid', message: '' })).toBe('refReviewMarksInvalid');
    expect(academyRefusalKey({ code: 'academy.review_already_sent', message: '' })).toBe('refReviewAlreadySent');
    expect(academyRefusalKey({ code: 'academy.review_task_not_found', message: '' })).toBe('refReviewTaskNotFound');
    expect(academyRefusalKey({ code: 'academy.peer_count_unset', message: '' })).toBe('refPeerCountUnset');
    expect(academyRefusalKey({ code: 'academy.file_unavailable', message: '' })).toBe('refFileUnavailable');
  });
});
