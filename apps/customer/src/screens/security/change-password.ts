import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';

/** What svc-identity answers when the password was changed. */
export const changed = z.object({ ok: z.literal(true) });

/** The server's own rule (auth.password_policy): at least 12 characters, at most 72 bytes. Checked here only to save a round trip. */
export function passwordProblem(next: string): 'short' | 'long' | null {
  if (next.length < 12) return 'short';
  if (new TextEncoder().encode(next).length > 72) return 'long';
  return null;
}

export type Outcome =
  | { kind: 'changed' }
  | { kind: 'wrongCurrent' }
  | { kind: 'policy' }
  | { kind: 'same' }
  | { kind: 'secondStep' }
  | { kind: 'locked' }
  | { kind: 'signedOut' }
  /** The request may or may not have reached the service. Never repeat it blindly. */
  | { kind: 'unknown' }
  | { kind: 'other'; code: string };

/** Turns the service's answer into one of the cases the screen has words for. */
export function outcomeOf(answer: ApiResult<unknown>): Outcome {
  if (answer.ok) return { kind: 'changed' };
  const code = answer.code ?? '';
  if (code === 'auth.invalid_credentials') return { kind: 'wrongCurrent' };
  if (code === 'auth.password_policy') return { kind: 'policy' };
  if (code === 'auth.password_unchanged') return { kind: 'same' };
  if (code === 'auth.mfa_required') return { kind: 'secondStep' };
  if (code === 'auth.too_many_attempts' || answer.status === 429) return { kind: 'locked' };
  if (answer.reason === 'unauthorized') return { kind: 'signedOut' };
  if (answer.reason === 'uncertain') return { kind: 'unknown' };
  return { kind: 'other', code };
}

/** One call: the service checks the current password, the rules, and (for an account with a second step) that this sign-in passed it. */
export function changePassword(api: ApiClient, input: { currentPassword: string; newPassword: string }, signal?: AbortSignal) {
  return api.mutate('identity', 'auth.changePassword', input, changed, { signal });
}
