import { describe, expect, it } from 'vitest';
import {
  SUPPORT_FORBIDDEN_SETTLEMENT_ACTS,
  SUPPORT_SETTLE_REFUSE,
  checkSupportSettlement,
  describeSupportSettlement,
  isForbiddenSettlementAct,
  noteImpliesSettlement,
} from './settlement-refuse.js';

describe('support settlement refuse — M17 cannot settle', () => {
  it('names the three acts the desk must never perform', () => {
    expect([...SUPPORT_FORBIDDEN_SETTLEMENT_ACTS].sort()).toEqual(
      ['complete_withdrawal', 'move_money', 'unfreeze_account'].sort(),
    );
    for (const act of SUPPORT_FORBIDDEN_SETTLEMENT_ACTS) {
      expect(isForbiddenSettlementAct(act)).toBe(true);
      expect(checkSupportSettlement({ act })).toEqual({
        status: 'refuse',
        reason: 'forbidden_act',
        code: SUPPORT_SETTLE_REFUSE,
      });
    }
  });

  it('citing an article is not a settlement act', () => {
    expect(isForbiddenSettlementAct('cite_kb')).toBe(false);
    expect(checkSupportSettlement({ act: 'cite_kb' }).status).toBe('ok');
    expect(describeSupportSettlement().canCiteArticles).toBe(true);
  });

  it('resolving a deposit_withdraw ticket implies a payout', () => {
    expect(
      checkSupportSettlement({ toStatus: 'resolved', category: 'deposit_withdraw' }),
    ).toEqual({
      status: 'refuse',
      reason: 'implied_payout',
      code: SUPPORT_SETTLE_REFUSE,
    });
  });

  it('closing a deposit_withdraw ticket without a payout claim is not a settle', () => {
    expect(checkSupportSettlement({ toStatus: 'closed', category: 'deposit_withdraw' }).status).toBe('ok');
  });

  it('resolving after a money_request escalation implies a payout', () => {
    expect(
      checkSupportSettlement({ toStatus: 'resolved', category: 'account', escalationReason: 'money_request' }),
    ).toEqual({
      status: 'refuse',
      reason: 'implied_payout',
      code: SUPPORT_SETTLE_REFUSE,
    });
  });

  it('a money_request file refuses resolved and closed even when a later reason is technical', () => {
    for (const toStatus of ['resolved', 'closed'] as const) {
      expect(
        checkSupportSettlement({
          toStatus,
          category: 'account',
          escalationReason: 'technical',
          escalationReasons: ['money_request', 'technical'],
        }),
      ).toEqual({
        status: 'refuse',
        reason: 'implied_payout',
        code: SUPPORT_SETTLE_REFUSE,
      });
    }
    expect(
      checkSupportSettlement({ toStatus: 'closed', category: 'deposit_withdraw', escalationReason: 'money_request' }),
    ).toEqual({
      status: 'refuse',
      reason: 'implied_payout',
      code: SUPPORT_SETTLE_REFUSE,
    });
    expect(
      checkSupportSettlement({ toStatus: 'resolved', category: 'account', escalationReasons: ['technical'] }).status,
    ).toBe('ok');
  });

  it('a resolve/close note that claims the money moved is refused', () => {
    for (const note of ['refunded via pay', 'withdrawal complete', 'unfrozen the account', 'payout sent', 'credited']) {
      expect(noteImpliesSettlement(note)).toBe(true);
      expect(checkSupportSettlement({ toStatus: 'resolved', category: 'other', note }).status).toBe('refuse');
      expect(checkSupportSettlement({ toStatus: 'closed', category: 'other', note }).status).toBe('refuse');
    }
  });

  it('a filler word between claim tokens still implies a payout', () => {
    const notes = ['withdrawal was completed', 'completed the withdrawal', 'moved the money', 'unfroze the account'];
    const statuses = ['resolved', 'closed'] as const;
    const categories = ['deposit_withdraw', 'other'] as const;
    for (const note of notes) {
      expect(noteImpliesSettlement(note)).toBe(true);
      for (const toStatus of statuses) {
        for (const category of categories) {
          expect(checkSupportSettlement({ toStatus, category, note })).toEqual({
            status: 'refuse',
            reason: 'implied_payout',
            code: SUPPORT_SETTLE_REFUSE,
          });
        }
      }
    }
  });

  it('does not treat "cannot refund" as a completed payout', () => {
    expect(noteImpliesSettlement('cannot refund — cite the deposit article')).toBe(false);
    expect(
      checkSupportSettlement({
        toStatus: 'closed',
        category: 'deposit_withdraw',
        note: 'cited kb-deposit-withdraw-honest',
      }).status,
    ).toBe('ok');
  });

  it('informational resolve (account/trading/other) stays legal', () => {
    expect(checkSupportSettlement({ toStatus: 'resolved', category: 'account' }).status).toBe('ok');
    expect(checkSupportSettlement({ toStatus: 'resolved', category: 'trading' }).status).toBe('ok');
    expect(checkSupportSettlement({ toStatus: 'pending', category: 'deposit_withdraw' }).status).toBe('ok');
  });

  it('honesty board is refuse-closed — never canSettle', () => {
    const board = describeSupportSettlement();
    expect(board.canSettle).toBe(false);
    expect(board.canCompleteWithdrawal).toBe(false);
    expect(board.canUnfreezeAccount).toBe(false);
    expect(board.canMoveMoney).toBe(false);
    expect(board.refuse).toBe(SUPPORT_SETTLE_REFUSE);
    expect(board.forbiddenActs).toEqual(SUPPORT_FORBIDDEN_SETTLEMENT_ACTS);
  });
});
