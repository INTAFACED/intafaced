import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { passwordIssue, passwordProblem, type PasswordIssue, type PasswordProblem } from '../../shared/password';

/**
 * Change password from Security. Backed by `identity` `auth.changePassword` ({ currentPassword, newPassword }).
 * Server rules (auth-service `changePassword`): a signed-in user session only, a second-factor session when the
 * account has a second factor, the current password re-checked, the new one differing from it. On success every
 * OTHER session is revoked and the caller's own stays. No password is kept here: the form reads it at send time.
 */
export const changedSchema = z.object({ ok: z.literal(true) });

export type ChangeIssue = PasswordIssue | 'currentMissing';
export type ChangeProblem = PasswordProblem | ChangeIssue;
export type ChangeState = { phase: 'idle'; problem: ChangeProblem | null } | { phase: 'sending' } | { phase: 'changed' };
export const initialChange: ChangeState = { phase: 'idle', problem: null };

export type ChangeEvent =
  { type: 'submit'; issue: ChangeIssue | null } | { type: 'answered'; result: ApiResult<unknown> } | { type: 'again' };

export function changeReducer(state: ChangeState, event: ChangeEvent): ChangeState {
  switch (event.type) {
    case 'submit':
      if (state.phase === 'sending') return state;
      return event.issue ? { phase: 'idle', problem: event.issue } : { phase: 'sending' };
    case 'answered':
      if (state.phase !== 'sending') return state;
      return event.result.ok ? { phase: 'changed' } : { phase: 'idle', problem: passwordProblem(event.result) };
    case 'again':
      return state.phase === 'changed' ? initialChange : state;
  }
}

/** What the browser can check before sending; the service refuses the same things. */
export function changeIssue(current: string, next: string, confirm: string): ChangeIssue | null {
  if (!current) return 'currentMissing';
  return passwordIssue(next, confirm);
}
