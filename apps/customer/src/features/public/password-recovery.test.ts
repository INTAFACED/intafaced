import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../shared/api';
import { recoveryCopy } from './password-recovery-copy';
import {
  RECOVERY_STEPS,
  clearsCode,
  completedSchema,
  initialRecovery,
  recoveryReducer,
  requestedSchema,
  stepStates,
  validEmail,
  type RecoveryState,
} from './password-recovery';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const refused = (extra: Partial<Refusal>): Refusal => ({ ok: false, reason: 'error', message: 'x', ...extra });
const accepted: ApiResult<unknown> = { ok: true, data: { accepted: true } };
const asked = (email = 'a@b.co'): RecoveryState => recoveryReducer(initialRecovery, { type: 'askCode', email });
const atReset = (): RecoveryState => recoveryReducer(asked(), { type: 'codeAnswered', result: accepted });

describe('password recovery journey', () => {
  it('walks request, then code with new password, then done', () => {
    expect(RECOVERY_STEPS).toEqual(['request', 'reset', 'done']);
    expect(stepStates('request')).toEqual({ request: 'current', reset: 'upcoming', done: 'upcoming' });
    expect(stepStates('reset')).toEqual({ request: 'done', reset: 'current', done: 'upcoming' });
  });

  it('parses exactly what the identity service answers', () => {
    expect(requestedSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(requestedSchema.safeParse({ accepted: false }).success).toBe(false);
    expect(completedSchema.safeParse({ ok: true }).success).toBe(true);
    expect(completedSchema.safeParse({}).success).toBe(false);
  });

  it('moves request, reset, done on real answers', () => {
    const sending = asked();
    expect(sending).toMatchObject({ step: 'request', busy: true, email: 'a@b.co' });
    const reset = recoveryReducer(sending, { type: 'codeAnswered', result: accepted });
    expect(reset).toMatchObject({ step: 'reset', busy: false, codeAsked: true, problem: null });
    const saving = recoveryReducer(reset, { type: 'reset', issue: null });
    expect(saving.busy).toBe(true);
    const done = recoveryReducer(saving, { type: 'resetAnswered', result: { ok: true, data: { ok: true } } });
    expect(done).toMatchObject({ step: 'done', busy: false, problem: null });
  });

  it('stops a bad email before anything is sent', () => {
    expect(validEmail('a@b.co')).toBe(true);
    expect(validEmail('nobody')).toBe(false);
    expect(validEmail('a b@c.d')).toBe(false);
    expect(asked('nobody')).toMatchObject({ step: 'request', busy: false, problem: 'invalidEmail' });
  });

  it('ignores a second submit while one request is in flight', () => {
    const sending = asked();
    expect(recoveryReducer(sending, { type: 'askCode', email: 'other@b.co' })).toBe(sending);
    const saving = recoveryReducer(atReset(), { type: 'reset', issue: null });
    expect(recoveryReducer(saving, { type: 'reset', issue: null })).toBe(saving);
    expect(recoveryReducer(saving, { type: 'restart' })).toBe(saving);
  });

  it('ignores answers that arrive when nothing is in flight', () => {
    expect(recoveryReducer(initialRecovery, { type: 'codeAnswered', result: accepted })).toBe(initialRecovery);
    const reset = atReset();
    expect(recoveryReducer(reset, { type: 'resetAnswered', result: { ok: true, data: { ok: true } } })).toBe(reset);
  });
});

describe('asking for a code does not reveal whether an email has an account', () => {
  it('gives the same result for an accepted request and for refusals that would confirm or deny an account', () => {
    const expected = atReset();
    for (const code of ['auth.not_found', 'auth.account_frozen', 'auth.email_taken', 'auth.invalid_credentials']) {
      const answered = recoveryReducer(asked(), { type: 'codeAnswered', result: refused({ code, status: 403 }) });
      expect(answered).toEqual(expected);
    }
    expect(expected.codeAsked).toBe(true);
  });

  it('says the same sentence whatever happens behind it', () => {
    expect(recoveryCopy.forLocale('en').t('codeOnItsWay')).toBe(
      'If an account uses this email, a code is on its way. It can take a few minutes to arrive.',
    );
  });

  it('still tells the truth when the server is off, busy or unreachable', () => {
    const problem = (extra: Partial<Refusal>) => recoveryReducer(asked(), { type: 'codeAnswered', result: refused(extra) }).problem;
    expect(problem({ code: 'auth.reset_unwired', status: 412 })).toBe('resetOff');
    expect(problem({ status: 429 })).toBe('rateLimited');
    expect(problem({ reason: 'unreachable' })).toBe('unreachable');
    expect(problem({ reason: 'uncertain', status: 502 })).toBe('unconfirmed');
    expect(problem({ status: 400, code: 'BAD_REQUEST' })).toBe('invalidEmail');
    // A refusal is never turned into the "code is on its way" screen.
    const off = recoveryReducer(asked(), { type: 'codeAnswered', result: refused({ code: 'auth.reset_unwired' }) });
    expect(off.step).toBe('request');
    expect(off.codeAsked).toBe(false);
  });
});

describe('finishing the reset', () => {
  it('stays on the form, with a typed problem, on every refusal', () => {
    const saving = recoveryReducer(atReset(), { type: 'reset', issue: null });
    const problem = (extra: Partial<Refusal>) => recoveryReducer(saving, { type: 'resetAnswered', result: refused(extra) });
    expect(problem({ code: 'auth.reset_proof_invalid', status: 400 })).toMatchObject({ step: 'reset', busy: false, problem: 'badCode' });
    expect(problem({ code: 'auth.password_policy', status: 400 }).problem).toBe('policy');
    expect(problem({ code: 'auth.password_unchanged', status: 400 }).problem).toBe('unchanged');
    expect(problem({ code: 'auth.reset_unwired', status: 412 }).problem).toBe('resetOff');
    expect(problem({ status: 429 }).problem).toBe('rateLimited');
    expect(clearsCode('badCode')).toBe(true);
    expect(clearsCode('policy')).toBe(false);
  });

  it('shows a mismatch before sending and does not go busy', () => {
    const state = recoveryReducer(atReset(), { type: 'reset', issue: 'mismatch' });
    expect(state).toMatchObject({ step: 'reset', busy: false, problem: 'mismatch' });
  });

  it('keeps no password or code anywhere in its state', () => {
    const states = [asked(), atReset(), recoveryReducer(atReset(), { type: 'reset', issue: null })];
    for (const state of states) expect(Object.keys(state).sort()).toEqual(['busy', 'codeAsked', 'email', 'problem', 'step']);
  });

  it('lets the person ask for a new code, keeping the address', () => {
    expect(recoveryReducer(atReset(), { type: 'restart' })).toEqual({ ...initialRecovery, email: 'a@b.co' });
  });
});
