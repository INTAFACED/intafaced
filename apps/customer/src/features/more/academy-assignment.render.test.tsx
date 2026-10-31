import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AcademyAssignmentView } from '@intafaced/contracts/academy-courses';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { AssignmentBrief, AssignmentGrade, AssignmentSubmissions, byteSize, percentOf } from './AcademyAssignment';
import { academyRefusalKey } from './academy-flows';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);

const VIEW: AcademyAssignmentView = {
  itemId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  courseSlug: 'risk-basics',
  courseTitle: 'Risk basics',
  title: 'Write-up',
  instructions: 'Size one trade.',
  points: '10',
  dueAt: '2026-10-25T12:00:00.000Z',
  text: 'required',
  file: 'optional',
  latePolicy: null,
  fileLimits: { maxBytes: 1_048_576, types: ['application/pdf', 'image/png'] },
  withdrawnAt: null,
  submissions: [],
  grade: null,
  nextVersion: 1,
  extension: null,
};

describe('an assignment page (AC-assignments-01)', () => {
  it('states what to hand in with the owner limits, and that the course has no late rule', () => {
    const out = html(<AssignmentBrief data={VIEW} />);
    expect(out).toContain('Text: required');
    expect(out).toContain('File: optional (application/pdf, image/png; up to 1 MiB)');
    expect(out).toContain('Late rule: this course has none.');
    expect(out).toContain('Worth 10 points');
    expect(out).toContain('href="/academy/learning/course/risk-basics"');
  });

  it("states the course's late rule in words, the share as a percentage worked out in digits (ENGINE GR-5)", () => {
    const out = html(<AssignmentBrief data={{ ...VIEW, latePolicy: { graceHours: '24', deductionPerDay: '0.1' } }} />);
    expect(out).toContain(
      'Late rule: 24 hours of grace after the due date, then 10% of the points off for each started day late, never below 0.',
    );
    expect(out).not.toContain('this course has none');
    expect([percentOf('0.1'), percentOf('0.0333'), percentOf('1'), percentOf('0.25'), percentOf('1.0000')]).toEqual([
      '10',
      '3.33',
      '100',
      '25',
      '100',
    ]);
  });

  it('shows the learner their own later due date with the reason, and nothing when they have none (AC-release-access-02)', () => {
    expect(html(<AssignmentBrief data={VIEW} />)).not.toContain('assignment-extension');
    const out = html(<AssignmentBrief data={{ ...VIEW, extension: { dueAt: '2026-10-28T12:00:00.000Z', reason: 'TEST illness' } }} />);
    expect(out).toContain('Your own due date, moved by the course team:');
    expect(out).toContain('Reason: TEST illness');
  });

  it('says the upload limits are not set rather than inventing one', () => {
    const out = html(<AssignmentBrief data={{ ...VIEW, fileLimits: { maxBytes: null, types: null } }} />);
    expect(out).toContain('the upload limits are not set, so no file is taken');
    expect(out).not.toContain('MiB');
  });

  it('lists hand-ins with their state and late flag; with none it says so and draws no row', () => {
    expect(html(<AssignmentSubmissions data={VIEW} />)).toContain('Nothing handed in yet.');
    const out = html(
      <AssignmentSubmissions
        data={{
          ...VIEW,
          submissions: [
            {
              version: 1,
              state: 'submitted',
              text: 'My answer',
              file: { id: '1f8fad5b-d9cb-469f-a165-70867728950e', fileName: 'a.pdf', contentType: 'application/pdf', bytes: 2048 },
              submittedAt: '2026-10-26T12:00:00.000Z',
              late: true,
            },
          ],
        }}
      />,
    );
    expect(out).toContain('Version 1');
    expect(out).toContain('Submitted');
    expect(out).toContain('Late');
    expect(out).toContain('a.pdf (2 KiB)');
  });

  it('names the missing part of an incomplete hand-in', () => {
    expect(academyRefusalKey({ code: 'academy.submission_incomplete', message: 'academy.submission_incomplete missing=file' })).toBe(
      'refSubmissionIncompleteFile',
    );
    expect(academyRefusalKey({ code: 'academy.enrolment_required', message: '' })).toBe('refEnrolmentRequired');
    expect(byteSize(1_048_576)).toBe('1 MiB');
  });
});

describe('a grade on an assignment page (AC-assignments-02)', () => {
  const GRADE = {
    version: 2,
    n: 1,
    score: '8',
    points: '10',
    entered: null,
    comment: 'TEST Clear sizing.',
    gradedAt: '2026-10-24T10:00:00.000Z',
    readAt: null,
  };
  it('shows score of points and the comment, never who graded it, with Mark as read until it is read', () => {
    const out = html(<AssignmentGrade grade={GRADE} marking={false} onMarkRead={() => {}} />);
    expect(out).toContain('8 of 10 points');
    expect(out).toContain('TEST Clear sizing.');
    expect(out).toContain('Mark as read');
    expect(out).not.toMatch(/graded by|founder/i);
    const read = html(<AssignmentGrade grade={{ ...GRADE, readAt: '2026-10-24T11:00:00.000Z' }} marking={false} onMarkRead={() => {}} />);
    expect(read).toContain('You read this feedback');
    expect(read).not.toContain('Mark as read');
    expect(out).not.toContain('late rule');
  });
  it('shows a late score with the grade staff entered beside it', () => {
    const out = html(<AssignmentGrade grade={{ ...GRADE, score: '6', entered: '8' }} marking={false} onMarkRead={() => {}} />);
    expect(out).toContain('6 of 10 points');
    expect(out).toContain('Entered as 8; the late rule took points off.');
  });
  it('says when there is no grade and when a grade has no comment, and words a missing grade refusal', () => {
    expect(html(<AssignmentGrade grade={null} marking={false} onMarkRead={() => {}} />)).toContain('Ungraded');
    expect(html(<AssignmentGrade grade={{ ...GRADE, comment: null }} marking={false} onMarkRead={() => {}} />)).toContain(
      'No comment came with this grade.',
    );
    expect(academyRefusalKey({ code: 'academy.submission_not_found', message: '' })).toBe('refGradeNotFound');
  });
});
