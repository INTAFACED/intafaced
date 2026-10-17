import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { Assessment, AttemptHistory, QuizView, StudyQuestions, submitBlock, type QuizViewProps } from './AcademyAssessment';
import { CertificateShelf, VerifyPanel, VerifyResult } from './AcademyCertificates';
import { PathProgrammesView, busyOf, programmeGuards, type ProgrammeBusy } from './AcademyProgrammeOverview';
import type { Assessment as AssessmentData, Attempt, Enrolment } from './academy-flows';
import { groupByPath, type LessonSummary } from './academy-lms';
import { academyLmsCopy } from './academy-lms-copy';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const owner = '11111111-1111-4111-8111-111111111111';
const code = '0123456789abcdef0123456789abcdef';

const assessment: AssessmentData = {
  slug: 'foundations-01',
  kind: 'quiz',
  passMark: 3,
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
const attempt = (score: number, at: string): Attempt => ({ slug: assessment.slug, score, maxScore: 3, pass: score >= 3, submittedAt: at });
const history = { status: 'ready' as const, data: [attempt(3, '2026-10-12T10:00:00.000Z'), attempt(1, '2026-10-11T10:00:00.000Z')] };
const noop = () => undefined;
const quizProps = (over: Partial<QuizViewProps> = {}): QuizViewProps => ({
  assessment,
  answers: {},
  onAnswer: noop,
  sending: false,
  result: null,
  problem: null,
  history,
  block: null,
  onSubmit: noop,
  onAnswerAgain: noop,
  onResend: noop,
  onRetryHistory: noop,
  onReloadQuestions: noop,
  ...over,
});
const quiz = (over: Partial<QuizViewProps> = {}) => html(<QuizView {...quizProps(over)} />);
const submitButton = (page: string) => /<button[^>]*type="submit"[^>]*>/.exec(page)?.[0] ?? '';
const failure = (code: string, message = code) => ({ ok: false as const, reason: 'error' as const, code, message });

describe('assessment questions', () => {
  it('lays out every question as a labelled radio group with its points, the pass mark and the count answered', () => {
    const page = quiz();
    expect((page.match(/<fieldset/g) ?? []).length).toBe(2);
    expect((page.match(/<legend/g) ?? []).length).toBe(2);
    expect((page.match(/type="radio"/g) ?? []).length).toBe(4);
    expect(page).toContain('What is a spot trade?');
    expect(page).toContain('Immediate delivery');
    expect(page).toContain('Question 1 of 2');
    expect(page).toContain('2 points');
    expect(page).toContain('1 point');
    expect(page).toContain('Pass mark: 3 of 3 points');
    expect(page).toContain('0 of 2 questions answered');
    expect(page).not.toContain('placeholder');
    expect(page).not.toContain('<textarea');
  });

  it('marks the chosen answers and counts them', () => {
    const page = quiz({ answers: { q1: 'a' } });
    expect(page).toMatch(/<input[^>]*checked=""[^>]*value="a"/);
    expect(page).toContain('1 of 2 questions answered');
  });

  it('keeps Submit off with its reason beside it until every question is answered', () => {
    const block = submitBlock({ sending: false, remaining: 2 });
    const page = quiz({ block });
    const button = submitButton(page);
    expect(button).toContain('disabled');
    const reasonId = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    expect(reasonId).toBeTruthy();
    expect(page).toContain(`id="${reasonId}"`);
    expect(page).toContain('Answer every question to submit. 2 still to answer.');
  });

  it('turns Submit on, with no reason shown, when everything is answered and the history is loaded', () => {
    const block = submitBlock({ sending: false, remaining: 0 });
    expect(block).toBeNull();
    const page = quiz({ answers: { q1: 'a', q2: 'b' }, block });
    expect(submitButton(page)).not.toContain('disabled');
    expect(submitButton(page)).not.toContain('aria-describedby');
    expect(page).not.toContain('Answer every question');
  });

  it('turns Submit off while a request is in flight, locks the answers and says so', () => {
    const block = submitBlock({ sending: true, remaining: 0 });
    const page = quiz({ answers: { q1: 'a', q2: 'b' }, sending: true, block });
    expect(submitButton(page)).toContain('disabled');
    expect(page).toContain('Your answers are being sent. Wait for Academy to reply.');
    expect((page.match(/<fieldset[^>]*disabled/g) ?? []).length).toBe(2);
    expect(page).toContain('aria-busy="true"');
    expect(page).toContain('Sending answers');
  });

  it('puts the reasons in order: in flight, unanswered, then on', () => {
    expect(submitBlock({ sending: true, remaining: 1 })).toEqual({ key: 'submitInFlight' });
    expect(submitBlock({ sending: false, remaining: 1 })).toEqual({ key: 'submitNeedsAnswers', remaining: 1 });
    expect(submitBlock({ sending: false, remaining: 0 })).toBeNull();
  });

  it('does not announce every click: the answered count is plain text, not a live region', () => {
    expect(quiz()).not.toMatch(/role="status"[^>]*>0 of 2 questions answered/);
  });
});

describe('assessment result and refusals', () => {
  it('shows the score Academy returned, the pass state, and a way to answer again instead of Submit', () => {
    const page = quiz({ answers: { q1: 'a', q2: 'a' }, result: { attempt: attempt(3, '2026-10-12T10:00:00.000Z'), recovered: false } });
    expect(page).toContain('Your result');
    expect(page).toContain('You scored 3 of 3 points.');
    expect(page).toContain('Passed');
    expect(page).toContain('Answer again');
    expect(submitButton(page)).toBe('');
    expect(page).not.toContain('The reply was lost');
    expect(page).toContain('tabindex="-1"');
  });

  it('says a result was read back from the attempt history when the reply was lost', () => {
    const page = quiz({ result: { attempt: attempt(1, '2026-10-12T10:00:00.000Z'), recovered: true } });
    expect(page).toContain('Not passed');
    expect(page).toContain('The first reply was lost.');
    expect(page).toContain('so it was not counted twice');
    expect(page).not.toContain('read back from your attempt history');
  });

  it('words a typed refusal and keeps the answers on screen', () => {
    const page = quiz({
      answers: { q1: 'a', q2: 'a' },
      problem: { kind: 'failure', failure: failure('academy.attempt_limit', 'academy.attempt_limit slug=x') },
    });
    expect(page).toContain('You have used every attempt this assessment allows.');
    expect(page).not.toContain('academy.attempt_limit');
    expect(page).toMatch(/<input[^>]*checked=""[^>]*value="a"/);
  });

  it('offers to reload the questions when Academy says the answers do not match them', () => {
    const page = quiz({ problem: { kind: 'failure', failure: failure('academy.assessment_invalid') } });
    expect(page).toContain('Reload questions');
    expect(quiz({ problem: { kind: 'failure', failure: failure('academy.attempt_limit') } })).not.toContain('Reload questions');
  });

  it('after a lost reply locks the answers, hides Submit and offers to send the same answers again', () => {
    const page = quiz({ answers: { q1: 'a', q2: 'a' }, problem: { kind: 'unconfirmed', failure: failure('x') } });
    expect(page).toContain('Send the same answers again');
    expect(page).toContain('cannot count it twice');
    expect(page).toContain('may count as a second one');
    expect(submitButton(page)).toBe('');
    expect((page.match(/<fieldset[^>]*disabled/g) ?? []).length).toBe(2);
    expect(page).not.toContain('Check attempt history');
    expect(page).not.toContain('shows no new attempt');
    expect(page).toMatch(/<input[^>]*checked=""[^>]*value="a"/);
  });

  it('turns the resend off while it is in flight, with its reason', () => {
    const page = quiz({ answers: { q1: 'a', q2: 'a' }, sending: true, problem: { kind: 'unconfirmed', failure: failure('x') } });
    expect(page).toMatch(/<button[^>]*disabled[^>]*>(?:<[^>]+>)*Sending answers/);
    expect(page).toContain('Your answers are being sent. Wait for Academy to reply.');
  });

  it('keeps the answers editable after a typed refusal', () => {
    const page = quiz({ answers: { q1: 'a', q2: 'a' }, problem: { kind: 'failure', failure: failure('academy.attempt_limit') } });
    expect((page.match(/<fieldset[^>]*disabled/g) ?? []).length).toBe(0);
  });

  it('words a refusal in Spanish and French too', () => {
    const f = failure('academy.attempt_cooldown');
    expect(academyLmsCopy.forLocale('es').t('refAttemptCooldown')).toContain('espera');
    expect(academyLmsCopy.forLocale('fr').t('refAttemptCooldown')).toContain('attente');
    expect(quiz({ problem: { kind: 'failure', failure: f } })).toContain('Try again later.');
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

  it('promises only what the product does: a code-only check for people signed in to INTAFACED', () => {
    for (const locale of ['en', 'es', 'fr'] as const) {
      const t = academyLmsCopy.forLocale(locale).t;
      expect(t('verifyIntro')).not.toMatch(/signed in or not|con o sin sesión|connecté ou non/i);
    }
    expect(academyLmsCopy.t('verifyIntro')).toContain('does not look at your account');
    expect(academyLmsCopy.t('sheetVerifyHint')).toContain('Anyone signed in to INTAFACED');
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
