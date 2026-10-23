import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { AcademyPlanner, AcademyProgressPage } from '@intafaced/contracts/academy-catalogue';
import { SessionProvider } from '../session/session';
import { PlannerView, ProgressPageView, localPercent, todoKey, type PlannerViewProps } from './AcademyProgressPage';
import { TimedQuizView } from './AcademyAssessment';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const noop = () => undefined;

const page: AcademyProgressPage = {
  courses: [
    {
      slug: 'markets',
      visible: 3,
      completed: 1,
      percent: '33.3',
      items: [
        { slug: 'm-1', title: 'TEST reading the book', kind: 'lesson', completedAt: '2026-10-20T10:00:00.000Z' },
        { slug: 'm-2', title: 'TEST order types', kind: 'lesson', completedAt: null },
        { slug: 'm-3', title: 'TEST spreads', kind: 'workbook', completedAt: null },
      ],
    },
  ],
  grades: {
    rows: [
      {
        pending: false,
        slug: 'm-2',
        title: 'TEST order types',
        type: 'quiz',
        attempts: 2,
        score: '3',
        possible: '4',
        percent: '75.0',
        passed: true,
      },
      { pending: true, slug: 'm-3', title: 'TEST spreads', type: 'quiz', attempts: 1, hiddenUntil: '2026-10-30T00:00:00.000Z' },
    ],
    averages: [{ type: 'quiz', percent: '75.0', count: 1 }],
  },
};

describe('progress page', () => {
  it('shows percent complete from the items the learner sees, with a check mark per completed item', () => {
    const out = html(<ProgressPageView page={page} />);
    expect(out).toContain('data-course-progress="markets"');
    expect(out).toContain('33.3% complete: 1 of 3 items');
    expect(out).toContain('aria-valuenow="33"');
    expect(out).toMatch(/data-progress-item="m-1" data-completed="true"[^>]*><span aria-hidden="true">✓/);
    expect(out).toMatch(/data-progress-item="m-2" data-completed="false"/);
    expect(out).toContain('Not completed');
  });

  it('charts each released quiz with its score and average, and holds a hidden result back behind a pending banner', () => {
    const out = html(<ProgressPageView page={page} />);
    expect(out).toContain('data-grade-chart="true"');
    expect(out).toContain('3 of 4 points (75.0%)');
    expect(out).toContain('Quiz average: 75.0% from one quiz');
    expect(out).toContain('data-grades-pending="1"');
    expect(out).toContain('One result is hidden until its release date.');
    expect(out).toMatch(/data-grade-row="m-3" data-grade-state="pending"/);
    expect(out).toContain('Result pending until');
    const pendingRow = out.slice(out.indexOf('data-grade-row="m-3"'));
    expect(pendingRow.slice(0, pendingRow.indexOf('</li>'))).not.toContain('points');
  });

  it('has empty states, never a zero chart: no course and no attempt', () => {
    const out = html(<ProgressPageView page={{ courses: [], grades: { rows: [], averages: [] } }} />);
    expect(out).toContain('You are not enrolled in a course.');
    expect(out).toContain('No quiz attempts on your account.');
    expect(out).not.toContain('data-grade-chart');
    expect(out).not.toContain('average');
  });
});

const planner: AcademyPlanner = {
  todos: [
    { id: '11111111-1111-4111-8111-111111111111', text: 'TEST read chapter two', createdAt: '2026-10-20T10:00:00.000Z', doneAt: null },
    {
      id: '22222222-2222-4222-8222-222222222222',
      text: 'TEST quiz',
      createdAt: '2026-10-20T10:00:00.000Z',
      doneAt: '2026-10-21T10:00:00.000Z',
    },
  ],
  todoLimit: 50,
  revision: 2,
  goal: { itemsPerWeek: 3, reminder: true, setAt: '2026-10-20T10:00:00.000Z', doneThisWeek: 1 },
  reminderMail: 'vendor.email',
};
const plannerView = (over: Partial<PlannerViewProps> = {}) =>
  html(
    <PlannerView
      planner={planner}
      draft=""
      onDraft={noop}
      onAdd={noop}
      onDone={noop}
      onRemove={noop}
      goalDraft={{ itemsPerWeek: '3', reminder: true }}
      onGoalDraft={noop}
      onSaveGoal={noop}
      onSendReminder={noop}
      busy={false}
      problem={null}
      goalSaved={false}
      reminderAnswered={false}
      {...over}
    />,
  );
const button = (out: string, label: string) => new RegExp(`<button[^>]*>(?:<[^>]+>)*${label}`).exec(out)?.[0] ?? '';

describe('planner', () => {
  it('lists the to-do items with their done state, and keeps Add off with its reason until there is text', () => {
    const out = plannerView();
    expect(out).toContain('TEST read chapter two');
    expect(out).toMatch(/data-todo-done="true"/);
    expect(button(out, 'Add to-do')).toContain('disabled');
    expect(out).toContain('Type the to-do item first.');
    expect(button(plannerView({ draft: 'TEST new' }), 'Add to-do')).not.toContain('disabled');
  });

  it('says why Add is off when the owner set no limit, or the list is full', () => {
    expect(plannerView({ draft: 'x', planner: { ...planner, todoLimit: null } })).toContain('Academy has no limit set for to-do items');
    expect(plannerView({ draft: 'x', planner: { ...planner, todoLimit: 2 } })).toContain(
      'You keep 2 to-do items, the most Academy allows.',
    );
  });

  it('shows the goal with this week’s count, and the reminder answer names the missing mail provider', () => {
    const out = plannerView({ goalSaved: true, reminderAnswered: true });
    expect(out).toContain('Goal: 3 items a week. 1 completed in the last 7 days.');
    expect(out).toContain('Email reminder on.');
    expect(out).toContain('Goal saved.');
    expect(out).toContain('data-not-connected="vendor.email"');
    expect(out).toContain('The goal reminder email needs an email delivery provider.');
  });

  it('keeps Send reminder off until a goal has its reminder on, and Save off outside 1 to 100', () => {
    const none = plannerView({ planner: { ...planner, goal: null } });
    expect(none).toContain('No weekly goal set.');
    expect(button(none, 'Send reminder now')).toContain('disabled');
    expect(none).toContain('Save a goal with the email reminder on first.');
    expect(button(plannerView({ goalDraft: { itemsPerWeek: '0', reminder: false } }), 'Save goal')).toContain('disabled');
  });
});

describe('a quiz whose results are hidden until a date', () => {
  it('says the answers are in and when the result shows, with no score', () => {
    const out = html(
      <TimedQuizView
        quiz={{ slug: 'm-3', kind: 'quiz', passMark: 1, timeLimitSeconds: null, attemptLimit: null, reviewMode: 'answers', questions: [] }}
        attempt={{
          attemptId: '33333333-3333-4333-8333-333333333333',
          slug: 'm-3',
          number: 1,
          startedAt: '2026-10-20T10:00:00.000Z',
          deadlineAt: null,
          secondsLeft: null,
          answers: {},
          result: { hidden: true, hiddenUntil: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-20T10:05:00.000Z' },
        }}
        secondsLeft={null}
        resumed={false}
        timeUp={false}
        position={0}
        saving="idle"
        sending={false}
        review={null}
        problem={null}
        history={{ status: 'ready', data: [] }}
        onStart={noop}
        onAnswer={noop}
        onMove={noop}
        onFinish={noop}
        onRetryHistory={noop}
      />,
    );
    expect(out).toContain('Your answers are in. Your result shows on');
    expect(out).not.toContain('You scored');
    expect(out).not.toContain('Passed');
  });
});

describe('planner keys and number format', () => {
  it('names one add by revision and text: other text on the same revision is another add, the same text is the same', () => {
    expect(todoKey(3, 'TEST read')).toBe(todoKey(3, ' TEST read '));
    expect(todoKey(3, 'TEST read')).not.toBe(todoKey(3, 'TEST quiz'));
    expect(todoKey(3, 'TEST read')).not.toBe(todoKey(4, 'TEST read'));
    expect(todoKey(3, 'TEST read')).toMatch(/^todo:3:[0-9a-f]{8}$/);
  });

  it('writes a percentage in the reader’s number format', () => {
    expect(localPercent('33.3', 'en')).toBe('33.3');
    expect(localPercent('33.3', 'fr')).toBe('33,3');
    expect(localPercent('100.0', 'es')).toBe('100,0');
  });
});
