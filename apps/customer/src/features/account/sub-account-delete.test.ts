import { describe, expect, it } from 'vitest';
import { subAccountDeleteMessages } from './sub-account-delete-copy';
import { BLOCKER_KEYS, DELETE_REFUSAL_KEYS, deleteCheck, deleteResult, deleteStepUp, isDeleteRefusal } from './sub-account-delete';

describe('sub-account delete', () => {
  it('begins a step-up bound to the sub-account id and the request id', () => {
    expect(deleteStepUp('s1', 'r1')).toEqual({
      scope: 'identity.step_up.sub_account_delete',
      purpose: 'account.subAccount.delete',
      target: 's1',
      fields: { subAccountId: 's1', clientRequestId: 'r1' },
    });
  });

  it('words every refusal the service can give and every blocker the money services return', () => {
    expect(Object.keys(DELETE_REFUSAL_KEYS)).toEqual([
      'identity.sub_account_delete_blocked',
      'identity.sub_account_check_unavailable',
      'identity.sub_account_not_found',
      'identity.sub_account_delete_delegated',
    ]);
    expect(BLOCKER_KEYS.open_order).toBe('blockOrder');
    expect(BLOCKER_KEYS.balance_remaining).toBe('blockBalance');
  });

  it('has a sentence in this card for every blocker code and every refusal it can show', () => {
    for (const key of [...Object.values(BLOCKER_KEYS), 'blockOther', ...Object.values(DELETE_REFUSAL_KEYS)]) {
      expect(Object.hasOwn(subAccountDeleteMessages, key), key).toBe(true);
    }
  });

  it('reads the answers strictly', () => {
    expect(deleteCheck.safeParse({ blockers: [{ code: 'open_order', count: 2 }], balances: [] }).success).toBe(true);
    expect(deleteCheck.safeParse({ blockers: [] }).success).toBe(false);
    expect(deleteResult.safeParse({ deleted: true, changed: false }).success).toBe(true);
    expect(deleteResult.safeParse({ deleted: false, changed: false }).success).toBe(false);
  });

  it('counts only the two read refusals as answered before any change', () => {
    const refused = (code: string, status = 412) => ({ ok: false as const, reason: 'refused' as never, message: '', code, status });
    expect(isDeleteRefusal(refused('identity.sub_account_delete_blocked'))).toBe(true);
    expect(isDeleteRefusal(refused('identity.sub_account_check_unavailable'))).toBe(true);
    expect(isDeleteRefusal(refused('identity.step_up_used'))).toBe(false);
    expect(isDeleteRefusal(refused('identity.sub_account_delete_blocked', 500))).toBe(false);
    expect(isDeleteRefusal({ ok: true, data: { revoked: true } })).toBe(false);
  });
});
