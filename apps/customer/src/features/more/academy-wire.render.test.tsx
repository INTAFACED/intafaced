import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import type { AcademyQuiz, AcademyQuizAttempt, AcademyQuizReview } from '@intafaced/contracts/academy-catalogue';
import { Assessment, AttemptHistory, StudyQuestions, TimedQuizView, clock, type TimedQuizViewProps } from './AcademyAssessment';
import { CertificateShelf, VerifyPanel, VerifyResult } from './AcademyCertificates';
import { PathProgrammesView, busyOf, programmeGuards, type ProgrammeBusy } from './AcademyProgrammeOverview';
import type { Attempt, Enrolment } from './academy-flows';
import { groupByPath, type LessonSummary } from './academy-lms';
import { academyLmsCopy } from './academy-lms-copy';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const owner = '11111111-1111-4111-8111-111111111111';
const code = '0123456789abcdef0123456789abcdef';

const quizData: AcademyQuiz = {
  slug: 'foundations-01',
  kind: 'quiz',
  passMark: 3,
  timeLimitSeconds: 600,
  attemptLimit: 2,
  reviewMode: 'answers',
  questions: [
    {
      id: 'q1',
      prompt: 'What is a spot trade?',
      kind: 'single',
      points: 2,
      choices: [
        { id: 'a', text: 'Immediate delivery' },
        { id: 'b', text: 'A future date' },
      ],
    },
    {
      id: 'q2',
      prompt: 'What does a limit order set?',
      kind: 'single',
      points: 1,
      choices: [
        { id: 'a', text: 'A worst price' },
        { id: 'b', text: 'A volume' },
      ],
    },
  ],
};
const attemptId = '22222222-2222-4222-8222-222222222222';
const openAttempt = (over: Partial<AcademyQuizAttempt> = {}): AcademyQuizAttempt => ({
  attemptId,
  slug: quizData.slug,
  number: 1,
  startedAt: '2026-10-12T10:00:00.000Z',
  deadlineAt: '2026-10-12T10:10:00.000Z',
  secondsLeft: 425,
  answers: {},
  result: null,
  ...over,
});
const finished = openAttempt({
  secondsLeft: null,
  answers: { q1: 'a', q2: 'b' },
  result: { hidden: false, score: 2, maxScore: 3, pass: false, finishedAt: '2026-10-12T10:05:00.000Z' },
});
const [q1, q2] = quizData.questions as [AcademyQuiz['questions'][number], AcademyQuiz['questions'][number]];
const reviewOf = (questions: AcademyQuizReview['questions']): AcademyQuizReview => ({
  attemptId,
  slug: quizData.slug,
  number: 1,
  score: 2,
  maxScore: 3,
  pass: false,
  finishedAt: '2026-10-12T10:05:00.000Z',
  reviewMode: questions === null ? 'score_only' : 'answers',
  questions,
});
const attempt = (score: number, at: string): Attempt => ({
  slug: quizData.slug,
  score,
  maxScore: 3,
  pass: score >= 3,
  submittedAt: at,
  hiddenUntil: null,
});
const history = { status: 'ready' as const, data: [attempt(3, '2026-10-12T10:00:00.000Z'), attempt(1, '2026-10-11T10:00:00.000Z')] };
const noop = () => undefined;
const quiz = (over: Partial<TimedQuizViewProps> = {}) =>
  html(
    <TimedQuizView
      quiz={quizData}
      attempt={null}
      secondsLeft={null}
      resumed={false}
      timeUp={false}
      position={0}
      saving="idle"
      sending={false}
      review={null}
      problem={null}
      history={history}
      onStart={noop}
      onAnswer={noop}
      onMove={noop}
      onFinish={noop}
      onRetryHistory={noop}
      {...over}
    />,
  );
const button = (page: string, label: string) => new RegExp(`<button[^>]*>(?:<[^>]+>)*${label}`).exec(page)?.[0] ?? '';
const submitButton = (page: string) => /<button[^>]*type="submit"[^>]*>/.exec(page)?.[0] ?? '';
const failure = (code: string, message = code) => ({ ok: false as const, reason: 'error' as const, code, message });

describe('timed quiz before an attempt', () => {
  it('states the rules first: pass mark, time limit, attempts allowed and what the review shows, then Start quiz', () => {
    const page = quiz();
    expect(page).toContain('data-quiz-state="ready"');
    expect(page).toContain('Pass mark: 3 of 3 points');
    expect(page).toContain('Time limit: 10 min');
    expect(page).toContain('Attempts allowed: 2');
    expect(page).toContain('When you finish, you see your own answers against the key.');
    expect(button(page, 'Start quiz')).not.toContain('disabled');
    expect(page).not.toContain('<fieldset');
    expect(page).not.toContain('role="timer"');
  });

  it('says when no limit applies, and when the review is the score only', () => {
    const page = quiz({ quiz: { ...quizData, timeLimitSeconds: null, attemptLimit: null, reviewMode: 'score_only' } });
    expect(page).toContain('No time limit');
    expect(page).toContain('No attempt limit');
    expect(page).toContain('When you finish, you see your score only.');
  });

  it('words a typed refusal at the attempt limit and keeps the history', () => {
    const page = quiz({ problem: failure('academy.attempt_limit', 'academy.attempt_limit slug=x') });
    expect(page).toContain('You have used every attempt this assessment allows.');
    expect(page).not.toContain('academy.attempt_limit');
    expect(page).toContain('2 attempts recorded');
  });
});

describe('timed quiz while an attempt is open', () => {
  it('shows one question at a time with its number, points, the clock from the server and the count answered', () => {
    const page = quiz({ attempt: openAttempt({ answers: { q1: 'a' } }), secondsLeft: 425 });
    expect(page).toContain('data-quiz-state="open"');
    expect((page.match(/<fieldset/g) ?? []).length).toBe(1);
    expect(page).toContain('data-quiz-question="q1"');
    expect(page).not.toContain('What does a limit order set?');
    expect(page).toContain('Question 1 of 2');
    expect(page).toContain('2 points');
    expect(page).toContain('Attempt 1');
    expect(page).toContain('role="timer"');
    expect(page).toContain('data-seconds-left="425"');
    expect(page).toContain('Time left: 7:05');
    expect(page).toContain('1 of 2 questions answered');
    expect(page).toMatch(/<input[^>]*checked=""[^>]*value="a"/);
    expect(button(page, 'Previous question')).toContain('disabled');
    expect(button(page, 'Next question')).not.toContain('disabled');
    expect(button(page, 'Finish and submit')).toContain('type="submit"');
  });

  it('moves to the last question with Next off there, and has no clock when the quiz has no time limit', () => {
    const page = quiz({ attempt: openAttempt({ deadlineAt: null, secondsLeft: null }), position: 1 });
    expect(page).toContain('data-quiz-question="q2"');
    expect(page).toContain('Question 2 of 2');
    expect(page).toContain('1 point');
    expect(button(page, 'Next question')).toContain('disabled');
    expect(page).not.toContain('role="timer"');
  });

  it('says an attempt found open on arrival is the same one, and reports the autosave', () => {
    expect(quiz({ attempt: openAttempt(), secondsLeft: 300, resumed: true })).toContain('Academy keeps the clock');
    expect(quiz({ attempt: openAttempt(), saving: 'saving' })).toContain('Saving your answer…');
    expect(quiz({ attempt: openAttempt(), saving: 'saved' })).toContain('Answer saved.');
  });

  it('locks the question and Finish while the submit is in flight', () => {
    const page = quiz({ attempt: openAttempt(), sending: true });
    expect(page).toMatch(/<fieldset[^>]*disabled/);
    expect(button(page, 'Submitting…')).toContain('disabled');
    expect(page).toContain('aria-busy="true"');
  });

  it('reads the clock as minutes and seconds, never below zero', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65)).toBe('1:05');
    expect(clock(-3)).toBe('0:00');
    expect(clock(600)).toBe('10:00');
  });
});

describe('timed quiz after an attempt', () => {
  it('shows the score Academy returned, the pass state and the learner’s own answers against the key', () => {
    const review = reviewOf([
      {
        id: 'q1',
        prompt: 'What is a spot trade?',
        choices: q1.choices,
        chosenChoiceId: 'a',
        correctChoiceId: 'a',
        correct: true,
      },
      {
        id: 'q2',
        prompt: 'What does a limit order set?',
        choices: q2.choices,
        chosenChoiceId: 'b',
        correctChoiceId: 'a',
        correct: false,
      },
    ]);
    const page = quiz({ attempt: finished, review });
    expect(page).toContain('data-quiz-state="finished"');
    expect(page).toContain(`data-quiz-result="${attemptId}"`);
    expect(page).toContain('You scored 2 of 3 points.');
    expect(page).toContain('Not passed');
    expect(page).toContain('data-quiz-review="answers"');
    expect(page).toContain('Your answer: Immediate delivery');
    expect(page).toContain('Your answer: A volume');
    expect(page).toContain('Correct answer: A worst price');
    expect(page).toContain('data-review-correct="false"');
    expect(button(page, 'Start another attempt')).not.toContain('disabled');
    expect(page).not.toContain('<fieldset');
  });

  it('shows the score only when the quiz says so, and says time ran out when the clock submitted', () => {
    const page = quiz({ attempt: finished, review: reviewOf(null), timeUp: true });
    expect(page).toContain('data-quiz-review="score_only"');
    expect(page).toContain('This quiz shows your score only, not the answers.');
    expect(page).not.toContain('Correct answer');
    expect(page).toContain('Time is up. Academy submitted the answers you had saved.');
  });

  it('says an unanswered question had no answer', () => {
    const review = reviewOf([
      {
        id: 'q1',
        prompt: 'What is a spot trade?',
        choices: q1.choices,
        chosenChoiceId: null,
        correctChoiceId: 'a',
        correct: false,
      },
    ]);
    expect(quiz({ attempt: finished, review })).toContain('Your answer: none');
  });

  it('words the new refusals in all three languages without the raw code', () => {
    for (const [code, key] of [
      ['academy.attempt_closed', 'refAttemptClosed'],
      ['academy.attempt_open', 'refAttemptOpen'],
      ['academy.attempt_not_found', 'refAttemptNotFound'],
      ['academy.attempt_required', 'refAttemptRequired'],
    ] as const) {
      const page = quiz({ problem: failure(code) });
      expect(page).toContain(academyLmsCopy.forLocale('en').t(key));
      expect(page).not.toContain(code);
      for (const locale of ['es', 'fr'] as const)
        expect(academyLmsCopy.forLocale(locale).t(key)).not.toBe(academyLmsCopy.forLocale('en').t(key));
    }
  });
});

describe('attempt history', () => {
  it('lists attempts newest first, numbered from the first, with score, pass state and time', () => {
    const page = html(<AttemptHistory history={history} onRetry={noop} />);
    expect(page).toContain('2 attempts recorded');
    expect(page.indexOf('Attempt 2')).toBeLessThan(page.indexOf('Attempt 1'));
    expect(page).toContain('3 of 3 points');
    expect(page).toContain('1 of 3 points');
    expect(page).toContain('Passed');
    expect(page).toContain('Not passed');
    expect(page).toContain('dateTime="2026-10-12T10:00:00.000Z"');
    expect(page).toContain('UTC');
  });

  it('has an empty state, a loading state and a failure with its reason', () => {
    expect(html(<AttemptHistory history={{ status: 'ready', data: [] }} onRetry={noop} />)).toContain(
      'No attempts are recorded for this lesson on your account.',
    );
    expect(html(<AttemptHistory history={{ status: 'loading' }} onRetry={noop} />)).toContain('Loading');
    const failed = html(
      <AttemptHistory
        history={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'The service could not be reached.' } }}
        onRetry={noop}
      />,
    );
    expect(failed).toContain('Try again');
  });

  it('says a single attempt in the singular', () => {
    expect(html(<AttemptHistory history={{ status: 'ready', data: [attempt(1, '2026-10-11T10:00:00.000Z')] }} onRetry={noop} />)).toContain(
      '1 attempt recorded',
    );
  });
});

describe('lesson assessment section', () => {
  it('opens in a loading state while Academy is asked for the questions, with no controls that do nothing', () => {
    const page = html(<Assessment slug="foundations-01" prompts={['Why does the price move?']} />);
    expect(page).toContain('Check your understanding');
    expect(page).toContain('Loading');
    expect(page).not.toContain('<textarea');
    expect(page).not.toContain('disabled');
    expect(page).not.toContain('aren’t saved');
  });

  it('keeps the lesson’s own study questions, labelled as unscored, when there is no assessment', () => {
    const page = html(<StudyQuestions prompts={['Why does the price move?', 'What would change your mind?']} />);
    expect(page).toContain('Questions to think about');
    expect(page).toContain('Nothing here is sent or scored.');
    expect(page).toContain('Why does the price move?');
    expect(html(<StudyQuestions prompts={[]} />)).toBe('');
  });
});

describe('certificate verify box', () => {
  it('waits for a code, and says so beside a switched-off button', () => {
    const page = html(<VerifyPanel reference="" onReference={noop} />);
    expect(page).toContain('Verification code');
    expect(page).toContain('Enter the 32-character verification code to check it.');
    expect(submitButton(page)).toContain('disabled');
    expect(submitButton(page)).toMatch(/aria-describedby="academy-verify-reason"/);
    expect(page).toContain('id="academy-verify-reason"');
    expect(page).not.toContain('Verify publicly');
  });

  it('turns the button on for a well-formed code, in any letter case', () => {
    for (const typed of [code, code.toUpperCase()]) {
      const page = html(<VerifyPanel reference={typed} onReference={noop} />);
      expect(submitButton(page)).not.toContain('disabled');
      expect(page).not.toContain('Enter the 32-character');
    }
  });

  it('explains a malformed code and a grant reference differently', () => {
    const bad = html(<VerifyPanel reference="nope" onReference={noop} />);
    expect(bad).toContain('A verification code is 32 characters long');
    expect(bad).toContain('aria-invalid="true"');
    expect(submitButton(bad)).toContain('disabled');
    const grant = html(<VerifyPanel reference={`cert:${owner}:foundations-v1`} onReference={noop} />);
    expect(grant).toContain('That is a grant reference');
    expect(submitButton(grant)).toContain('disabled');
  });

  it('shows what Academy returned for a valid certificate, with the holder only when shared', () => {
    const page = html(
      <VerifyResult
        code={code}
        certificate={{ certId: 'foundations-v1', title: 'Foundations', grantedAt: '2026-10-10T08:00:00.000Z', status: 'valid' }}
      />,
    );
    expect(page).toContain('Foundations');
    expect(page).toContain('Not shared by the holder');
    expect(page).toContain('Valid');
    expect(page).toContain('October');
    expect(page).toContain(code);
    expect(page).toContain('has not been revoked');
    const named = html(
      <VerifyResult
        code={code}
        certificate={{
          certId: 'foundations-v1',
          title: 'Foundations',
          grantedAt: '2026-10-10T08:00:00.000Z',
          status: 'valid',
          holderName: 'A. Learner',
        }}
      />,
    );
    expect(named).toContain('A. Learner');
    expect(named).not.toContain('Not shared by the holder');
  });

  it('says plainly that a revoked certificate is no longer valid', () => {
    const page = html(
      <VerifyResult
        code={code}
        certificate={{ certId: 'foundations-v1', title: 'Foundations', grantedAt: '2026-10-10T08:00:00.000Z', status: 'revoked' }}
      />,
    );
    expect(page).toContain('Revoked');
    expect(page).toContain('It is no longer valid.');
    expect(page).not.toContain('>Valid<');
  });
});

describe('verify box placement and copy', () => {
  it('is drawn beside the shelf, not inside the tracking read, so it shows while that read is still loading or has failed', () => {
    const page = html(<CertificateShelf />);
    expect(page).toContain('Loading');
    expect(page).toContain('Verify certificate');
    expect(page).toContain('Verification code');
  });

  it('promises only what the product does: the verify box checks a code; the sheet’s link opens the public check (AC-certificates-01)', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const t = academyLmsCopy.forLocale(locale).t;
      expect(t('verifyIntro')).not.toMatch(/signed in or not|con o sin sesión|connecté ou non/i);
    }
    expect(academyLmsCopy.t('verifyIntro')).toContain('does not look at your account');
    expect(academyLmsCopy.t('sheetVerifyHint')).toContain('Anyone with its link or its serial number');
  });
});

describe('which busy state the buttons report', () => {
  const free = { stage: noop, disabled: false, isCurrent: () => true, result: null };
  it('tells this page’s own request from an unconfirmed one, and a free action from both', () => {
    expect(busyOf(free)).toBeNull();
    expect(busyOf({ ...free, disabled: true, busy: true })).toBe('inflight');
    expect(busyOf({ ...free, disabled: true, busy: false, snapshot: { status: 'other' } })).toBe('unconfirmed');
    expect(busyOf({ ...free, disabled: true, busy: false, snapshot: { status: 'empty', known: {} } })).toBe('unconfirmed');
    expect(busyOf({ ...free, busy: false, snapshot: { status: 'empty' } })).toBeNull();
  });
});

describe('programme enrolments', () => {
  const lessons: LessonSummary[] = [
    { slug: 'f-1', title: 'One', kind: 'lesson', path: 'foundations', order: 1, summary: '', estimatedMinutes: 5 },
    { slug: 'm-1', title: 'Two', kind: 'lesson', path: 'markets', order: 1, summary: '', estimatedMinutes: 5 },
  ];
  const groups = groupByPath(lessons);
  const row = (pathSlug: string): Enrolment => ({ userId: owner, pathSlug, enrolledAt: '2026-10-01T08:00:00.000Z' });
  const view = (over: Partial<Parameters<typeof PathProgrammesView>[0]> = {}) =>
    html(
      <PathProgrammesView
        enrolments={{ status: 'ready', data: [row('markets')] }}
        reload={noop}
        groups={groups}
        signedIn
        busy={null}
        onEnrol={noop}
        onLeave={noop}
        {...over}
      />,
    );
  const card = (page: string, title: string) => {
    const start = page.indexOf(`<h3>${title}</h3>`);
    return page.slice(start, page.indexOf('</article>', start));
  };

  it('reads the enrolments back: a summary, each programme with its start date, and a status on every card', () => {
    const page = view();
    expect(page).toContain('My enrolments');
    expect(page).toContain('You are enrolled in 1 of 4 programmes.');
    expect(page).toContain('dateTime="2026-10-01T08:00:00.000Z"');
    expect(page).toContain('Enrolled since October 1, 2026');
    expect(card(page, 'Foundations')).toContain('Not enrolled');
    expect(card(page, 'Markets')).toContain('Enrolled since');
    expect(page).not.toContain('doesn’t read your enrolment');
  });

  const button = (markup: string, label: string) => new RegExp(`<button[^>]*>(?:<[^>]+>)*${label}<`).exec(markup)?.[0] ?? '';

  it('lets a person enrol where they are not enrolled and leave where they are, with the reason on the other button', () => {
    const page = view();
    const foundations = card(page, 'Foundations');
    expect(foundations).toContain('You are not enrolled in this programme, so there is nothing to leave.');
    expect(button(foundations, 'Enrol')).not.toBe('');
    expect(button(foundations, 'Enrol')).not.toContain('disabled');
    const markets = card(page, 'Markets');
    expect(markets).toContain('You are already enrolled in this programme.');
    expect(button(markets, 'Enrol')).toContain('disabled');
    expect(button(markets, 'Leave programme')).not.toBe('');
    expect(button(markets, 'Leave programme')).not.toContain('disabled');
    expect(button(foundations, 'Leave programme')).toContain('disabled');
  });

  it('shows the empty state when the account is enrolled nowhere', () => {
    const page = view({ enrolments: { status: 'ready', data: [] } });
    expect(page).toContain('You are not enrolled in any programme.');
    expect(page).not.toContain('You are enrolled in');
  });

  it('shows loading, and a failure with its reason, and gives both buttons a reason while it cannot tell', () => {
    const loading = view({ enrolments: { status: 'loading' } });
    expect(loading).toContain('Loading');
    expect(loading).toContain('Your enrolments are loading, so the right action cannot be chosen.');
    const failed = view({
      enrolments: { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'The service could not be reached.' } },
    });
    expect(failed).toContain('Your enrolments could not be read, so the right action cannot be chosen.');
    expect(failed).toContain('Try again');
    for (const page of [loading, failed]) expect((page.match(/<button[^>]*disabled/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  it('says why when another Academy request is open', () => {
    const page = view({ busy: 'inflight' });
    expect(card(page, 'Foundations')).toContain('Academy is answering a request from this page.');
  });

  it('says the true thing when an earlier request was never confirmed, instead of asking to close something', () => {
    const page = view({ busy: 'unconfirmed' });
    expect(card(page, 'Foundations')).toContain('An earlier Academy request was not confirmed. Read the notice on this page.');
    expect(page).not.toContain('Finish or close it first');
  });

  it('keeps every button reason in the guard table', () => {
    const base = { signedIn: true, enrolments: 'ready' as const, enrolled: false, busy: null as ProgrammeBusy };
    expect(programmeGuards(base)).toEqual({ enrol: null, leave: 'refEnrollmentNotFound' });
    expect(programmeGuards({ ...base, enrolled: true })).toEqual({ enrol: 'enrolReasonEnrolled', leave: null });
    expect(programmeGuards({ ...base, busy: 'inflight' })).toEqual({ enrol: 'actionInFlightReason', leave: 'refEnrollmentNotFound' });
    expect(programmeGuards({ ...base, enrolled: true, busy: 'unconfirmed' })).toEqual({
      enrol: 'enrolReasonEnrolled',
      leave: 'actionUnconfirmedReason',
    });
    expect(programmeGuards({ ...base, signedIn: false })).toEqual({ enrol: 'signInReason', leave: 'signInReason' });
    expect(programmeGuards({ ...base, enrolments: 'loading' })).toEqual({
      enrol: 'enrolmentsLoadingReason',
      leave: 'enrolmentsLoadingReason',
    });
    expect(programmeGuards({ ...base, enrolments: 'failed' })).toEqual({
      enrol: 'enrolmentsUnreadableReason',
      leave: 'enrolmentsUnreadableReason',
    });
  });
});
