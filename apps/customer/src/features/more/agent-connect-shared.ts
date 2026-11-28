/**
 * What the parts of the Connect your assistant room share (AgentConnect.tsx, AgentAccountControls.tsx): a refusal's
 * words and a signing step's name.
 */
import type { ApiResult } from '../../shared/api';
import type { agentConnectCopy } from './agent-connect-copy';

export type Failed = Extract<ApiResult<unknown>, { ok: false }>;
export type Words = ReturnType<typeof agentConnectCopy.useCopy>['t'];

const REFUSAL_KEYS = {
  'refused.auth.agent_scope_forbidden': true,
  'refused.auth.scope_empty': true,
  'refused.identity.key_name_invalid': true,
  'refused.identity.key_name_taken': true,
  'refused.identity.key_expiry_invalid': true,
  'refused.auth.webauthn_invalid': true,
  'refused.auth.passkey_missing': true,
} as const;
type RefusalKey = keyof typeof REFUSAL_KEYS;

/** A refusal in this room's words when it has some, else the service's own sentence with its code. */
export function refusalText(t: Words, failed: Failed): string {
  const key = `refused.${failed.code ?? ''}`;
  if (failed.code && key in REFUSAL_KEYS) return t(key as RefusalKey);
  return t('refusedOther', { message: [failed.code, failed.message].filter(Boolean).join(': ') });
}

export const STEP_KEY: Record<
  string,
  'step_open_sub_account' | 'step_approve_agent' | 'step_move_in' | 'step_move_out' | 'step_revoke_agent'
> = {
  open_sub_account: 'step_open_sub_account',
  approve_agent: 'step_approve_agent',
  move_in: 'step_move_in',
  move_out: 'step_move_out',
  revoke_agent: 'step_revoke_agent',
};
