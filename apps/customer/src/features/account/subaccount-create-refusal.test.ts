import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../shared/api';
import { createRefusalKey, isCreateRefusal } from './subaccount-guards';

const refused = (code: string, status: number, reason = 'error'): ApiResult<unknown> =>
  ({ ok: false, reason, message: code, code, status }) as ApiResult<unknown>;

describe('sub-account create refusals', () => {
  it('reads identity’s typed 4xx refusals as known, each with its own sentence', () => {
    expect(createRefusalKey(refused('auth.sub_account_cap_unset', 412))).toBe('refusedCapUnset');
    expect(createRefusalKey(refused('auth.sub_account_limit', 403, 'forbidden'))).toBe('refusedLimit');
    expect(createRefusalKey(refused('auth.account_frozen', 403, 'forbidden'))).toBe('refusedFrozen');
    expect(createRefusalKey(refused('auth.not_found', 404, 'not_mounted'))).toBe('refusedNotFound');
    for (const answer of [refused('auth.sub_account_cap_unset', 412), refused('auth.sub_account_limit', 403, 'forbidden')])
      expect(isCreateRefusal(answer)).toBe(true);
  });

  it('keeps every other answer unconfirmed', () => {
    // A known code at another status, an unknown code, an uncertain answer and a success are not refusals.
    expect(isCreateRefusal(refused('auth.sub_account_cap_unset', 200))).toBe(false);
    expect(isCreateRefusal(refused('constructor', 403, 'forbidden'))).toBe(false);
    expect(isCreateRefusal(refused('auth.something_else', 412))).toBe(false);
    expect(isCreateRefusal(refused('auth.sub_account_cap_unset', 502, 'uncertain'))).toBe(false);
    expect(isCreateRefusal(refused('auth.sub_account_limit', 403, 'uncertain'))).toBe(false);
    expect(isCreateRefusal({ ok: false, reason: 'error', message: 'x', status: 412 } as ApiResult<unknown>)).toBe(false);
    expect(isCreateRefusal({ ok: true, data: { id: 'x' } } as ApiResult<unknown>)).toBe(false);
  });
});
