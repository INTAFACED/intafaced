import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, InvalidEntryError, LedgerError, OwnerIdentitySpaceError } from './types.js';
import { rehydrateLedgerHttpError } from './http-errors.js';
import { IDEMPOTENCY_CONFLICT_CODE } from './client.js';
import { DEFINITE_POST_REFUSAL_CODES, POST_IN_FLIGHT_BOUND_SECONDS, classifyPostOutcome, provesPostNotCommitted } from './post-outcome.js';

const withCause = (code: string, depth = 1): Error => {
  let inner: unknown = Object.assign(new Error('socket'), { code });
  for (let i = 1; i < depth; i++) inner = new Error('wrapper', { cause: inner });
  return new Error('fetch failed', { cause: inner });
};

describe('classifyPostOutcome', () => {
  it('a named ledger refusal proves nothing committed', () => {
    for (const code of DEFINITE_POST_REFUSAL_CODES) {
      expect(classifyPostOutcome(new LedgerError('refused', code))).toBe('refused');
    }
    expect(classifyPostOutcome(new InsufficientFundsError('acct', 'USDT', '5' as never, '1' as never))).toBe('refused');
    expect(classifyPostOutcome(new InvalidEntryError('bad'))).toBe('refused');
    expect(classifyPostOutcome(new OwnerIdentitySpaceError('user', 'x'))).toBe('refused');
  });

  it('a reused key with a different body proves the key already committed, so it is never a refusal', () => {
    expect(DEFINITE_POST_REFUSAL_CODES.has(IDEMPOTENCY_CONFLICT_CODE)).toBe(false);
    expect(classifyPostOutcome(new LedgerError('conflict', IDEMPOTENCY_CONFLICT_CODE))).toBe('unknown');
  });

  it('codes raised by the HTTP door before the key is looked up are unknown, not refusals', () => {
    for (const code of ['ledger.unauthenticated', 'ledger.recipe_required', 'ledger.freeze_attributed']) {
      expect(DEFINITE_POST_REFUSAL_CODES.has(code)).toBe(false);
      expect(classifyPostOutcome(new LedgerError('x', code))).toBe('unknown');
    }
  });

  it('a connect failure that happened before any byte was sent is unsent only for a single-attempt caller', () => {
    const once = { singleAttempt: true };
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(classifyPostOutcome(withCause(code), once)).toBe('unsent');
      expect(classifyPostOutcome(withCause(code, 3), once)).toBe('unsent');
    }
    expect(classifyPostOutcome(withCause('ECONNREFUSED', 4), once)).toBe('unknown');
  });

  it('a retrying client only reports its last attempt, so a connect failure is never proof there', () => {
    // Attempt 0 may have committed before the ledger restarted; attempts 1 and 2 then failed to connect.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(classifyPostOutcome(withCause(code))).toBe('unknown');
      expect(classifyPostOutcome(withCause(code), { singleAttempt: false })).toBe('unknown');
      expect(provesPostNotCommitted(withCause(code))).toBe(false);
    }
  });

  it('a code on the error itself is not proof the request was never sent', () => {
    expect(classifyPostOutcome(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), { singleAttempt: true })).toBe('unknown');
  });

  it('a reset, a hang up, a timeout, a 5xx and anything untyped stay unknown', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT']) expect(classifyPostOutcome(withCause(code))).toBe('unknown');
    expect(classifyPostOutcome(new Error('socket hang up'))).toBe('unknown');
    expect(classifyPostOutcome(new LedgerError('boom', 'ledger.internal'))).toBe('unknown');
    expect(classifyPostOutcome(rehydrateLedgerHttpError('/trpc/post', 502, '<html>bad gateway</html>'))).toBe('unknown');
    for (const odd of [null, undefined, 'x', 42, {}]) expect(classifyPostOutcome(odd)).toBe('unknown');
  });

  it('classifies the error the HTTP client rebuilds from a ledger reply', () => {
    const body = (code: string) => JSON.stringify({ code, message: 'm' });
    expect(classifyPostOutcome(rehydrateLedgerHttpError('/trpc/post', 412, body('ledger.frozen')))).toBe('refused');
    expect(classifyPostOutcome(rehydrateLedgerHttpError('/trpc/post', 409, body(IDEMPOTENCY_CONFLICT_CODE)))).toBe('unknown');
  });

  it('provesPostNotCommitted is true for refused and unsent only', () => {
    expect(provesPostNotCommitted(new LedgerError('x', 'ledger.frozen'))).toBe(true);
    expect(provesPostNotCommitted(withCause('ENOTFOUND'), { singleAttempt: true })).toBe(true);
    expect(provesPostNotCommitted(new LedgerError('x', IDEMPOTENCY_CONFLICT_CODE))).toBe(false);
    expect(provesPostNotCommitted(new Error('timeout'))).toBe(false);
  });

  it('the in-flight bound is seven minutes', () => {
    expect(POST_IN_FLIGHT_BOUND_SECONDS).toBe(420);
  });
});
