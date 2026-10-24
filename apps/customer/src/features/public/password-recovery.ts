import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { passwordProblem, type PasswordIssue, type PasswordProblem } from '../../shared/password';

/**
 * Password recovery, as a journey: ask for a code, enter the code with a new password, done.
 * Backed by `identity` `auth.requestPasswordReset` ({ email }) and `auth.completePasswordReset` ({ email, code, newPassword }).
 * The reducer here holds no password and no code: those live in the form inputs only, are read at submit and cleared.
 */
export const RECOVERY_STEPS = ['request', 'reset', 'done'] as const;
export type RecoveryStep = (typeof RECOVERY_STEPS)[number];

export const requestedSchema = z.object({ accepted: z.literal(true) });
export const completedSchema = z.object({ ok: z.literal(true) });

export type StepState = 'current' | 'upcoming' | 'done';

/** Which step is current, which are behind it and which are ahead. */
export function stepStates(current: RecoveryStep): Record<RecoveryStep, StepState> {
  const at = RECOVERY_STEPS.indexOf(current);
  return Object.fromEntries(
    RECOVERY_STEPS.map((step, index) => [step, index < at ? 'done' : index === at ? 'current' : 'upcoming']),
  ) as Record<RecoveryStep, StepState>;
}

export type RecoveryProblem = PasswordProblem | PasswordIssue | 'invalidEmail' | 'codeMissing';
export interface RecoveryState {
  step: RecoveryStep;
  /** The address the code was asked for. An email address is not a secret; it is needed again to finish. */
  email: string;
  /** One request at a time: while true every submit is ignored. */
  busy: boolean;
  /** The "if an account uses this email" notice, shown on the reset step. */
  codeAsked: boolean;
  problem: RecoveryProblem | null;
}
export const initialRecovery: RecoveryState = { step: 'request', email: '', busy: false, codeAsked: false, problem: null };

export type RecoveryEvent =
  | { type: 'askCode'; email: string }
  | { type: 'codeAnswered'; result: ApiResult<unknown> }
  | { type: 'reset'; issue: PasswordIssue | 'codeMissing' | null }
  | { type: 'resetAnswered'; result: ApiResult<unknown> }
  | { type: 'restart' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
export function validEmail(email: string): boolean {
  return email.length <= 320 && EMAIL.test(email);
}

/**
 * Refusals that would reveal whether an address has an account. The page answers these exactly like a success
 * (the service itself does not send them for this call; this keeps the page safe if that ever changes).
 */
const ENUMERATING = new Set(['auth.not_found', 'auth.account_frozen', 'auth.email_taken', 'auth.invalid_credentials']);

/**
 * What a request for a mail (a reset code or the handle) answered: null when the page says "on its way", else the
 * problem to show. A refusal that would reveal whether the address has an account reads as "on its way" too.
 */
export function requestProblem(result: ApiResult<unknown>): RecoveryProblem | null {
  if (result.ok || (result.code && ENUMERATING.has(result.code))) return null;
  const problem = passwordProblem(result);
  return problem === 'invalidInput' ? 'invalidEmail' : problem === 'unconfirmed' ? 'requestUnconfirmed' : problem;
}

export function recoveryReducer(state: RecoveryState, event: RecoveryEvent): RecoveryState {
  switch (event.type) {
    case 'askCode': {
      if (state.busy || state.step !== 'request') return state;
      const email = event.email.trim();
      if (!validEmail(email)) return { ...state, email, problem: 'invalidEmail' };
      return { ...state, email, busy: true, problem: null };
    }
    case 'codeAnswered': {
      if (!state.busy || state.step !== 'request') return state;
      const problem = requestProblem(event.result);
      if (problem === null) return { ...state, step: 'reset', busy: false, codeAsked: true, problem: null };
      return { ...state, busy: false, problem };
    }
    case 'reset': {
      if (state.busy || state.step !== 'reset') return state;
      if (event.issue) return { ...state, problem: event.issue };
      return { ...state, busy: true, problem: null };
    }
    case 'resetAnswered': {
      if (!state.busy || state.step !== 'reset') return state;
      if (event.result.ok) return { ...state, step: 'done', busy: false, problem: null };
      return { ...state, busy: false, problem: passwordProblem(event.result) };
    }
    case 'restart':
      if (state.busy) return state;
      return { ...initialRecovery, email: state.email };
  }
}

/** Problems after which the typed code is no use and should be wiped from its field. */
export function clearsCode(problem: RecoveryProblem | null): boolean {
  return problem === 'badCode';
}
