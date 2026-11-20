import { describe, expect, it } from 'vitest';
import { bankAnswered, nextHeldId } from './held-id';

describe('a business team form keeps its request id until the bank answers (J-bank-19)', () => {
  it('a lost answer, a network failure or an untyped error keeps the id; a done request or a typed refusal renews it', () => {
    expect(bankAnswered({ ok: false, code: 'bank.partner_reply_lost' })).toBe(false);
    expect(bankAnswered({ ok: false, code: 'bank.partner_unavailable' })).toBe(false);
    expect(bankAnswered({ ok: false, code: 'bank.ledger_outcome_unknown' })).toBe(false);
    expect(bankAnswered({ ok: false })).toBe(false);
    expect(bankAnswered({ ok: false, code: 'INTERNAL_SERVER_ERROR' })).toBe(false);
    expect(bankAnswered({ ok: true })).toBe(true);
    expect(bankAnswered({ ok: false, code: 'bank.business_approvers_short' })).toBe(true);
    expect(bankAnswered({ ok: false, code: 'bank.business_request_conflict' })).toBe(true);
  });

  it('pressing again after a lost answer sends the same payment id, so the partner instruction is the same key', () => {
    let n = 0;
    const mint = () => `id-${++n}`;
    const first = mint();
    let id = nextHeldId(first, { ok: false, code: 'bank.partner_reply_lost' }, mint);
    expect(id).toBe(first);
    id = nextHeldId(id, { ok: false }, mint);
    expect(id).toBe(first);
    id = nextHeldId(id, { ok: true }, mint);
    expect(id).not.toBe(first);
  });
});
