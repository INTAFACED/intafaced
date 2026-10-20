import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { SecurityStepUpError, toSecurityStepUpTrpc, type SecurityStepUpCode } from './security-step-up.js';
import { userCopy } from '../user-copy.js';

const CODES: readonly SecurityStepUpCode[] = [
  'identity.step_up_required',
  'identity.second_factor_required',
  'identity.step_up_expired',
  'identity.step_up_used',
  'identity.step_up_not_yours',
  'identity.step_up_target',
  'identity.delegated_refused',
];

function caught(err: unknown): TRPCError {
  try {
    toSecurityStepUpTrpc(err);
  } catch (thrown) {
    return thrown as TRPCError;
  }
  throw new Error('did not throw');
}

describe('toSecurityStepUpTrpc', () => {
  it('answers every guard code with its copy, FORBIDDEN for a delegated caller and PRECONDITION_FAILED otherwise', () => {
    for (const code of CODES) {
      const out = caught(new SecurityStepUpError(code));
      expect(out.code).toBe(code === 'identity.delegated_refused' ? 'FORBIDDEN' : 'PRECONDITION_FAILED');
      expect(out.message).toBe(userCopy(code));
      expect(out.message).not.toBe(code);
      expect((out.cause as SecurityStepUpError).code).toBe(code);
    }
  });

  it('lets any other error through unchanged', () => {
    const other = new Error('boom');
    expect(caught(other)).toBe(other);
  });
});
