import { describe, expect, it, vi } from 'vitest';
import type { StaffHold, StaffHoldResult } from '@intafaced/contracts/ops-staff-holds';
import { holdActionable, movementLine, placeKey, readPlaceForm } from './holds';

vi.mock('server-only', () => ({}));

const { holdReply } = await import('./holds-server');

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const form = {
  userId: USER,
  assetId: 'USDT',
  amount: '40.00',
  reason: 'TEST suspected takeover',
  expiresInHours: null,
  idempotencyKey: `console:hold:${USER}:after:0`,
};
const hold = (over: Partial<StaffHold> = {}): StaffHold => ({
  holdNo: '1',
  userId: USER,
  assetId: 'USDT',
  amount: '40',
  remaining: '40',
  state: 'active',
  reason: form.reason,
  expiresAt: null,
  placedBy: '11111111-1111-4111-8111-111111111111',
  placedAt: '2026-10-24T08:00:00.000Z',
  movements: [
    {
      kind: 'place',
      no: '1',
      amount: '40',
      status: 'posted',
      cause: 'staff',
      idempotencyKey: 'ops:hold:1',
      requesterId: null,
      approverId: null,
      txId: 'tx-1',
      code: null,
      at: '2026-10-24T08:00:00.000Z',
    },
  ],
  ...over,
});

describe('the staff hold place form', () => {
  it('takes exactly what svc-ops takes, with the console’s business key', () => {
    expect(readPlaceForm(form)).toEqual(form);
    expect(readPlaceForm({ ...form, expiresInHours: 24 })).toMatchObject({ expiresInHours: 24 });
    expect(readPlaceForm({ ...form, amount: '0' })).toBeNull();
    expect(readPlaceForm({ ...form, amount: '1e3' })).toBeNull();
    expect(readPlaceForm({ ...form, assetId: 'usdt' })).toBeNull();
    expect(readPlaceForm({ ...form, reason: ' padded ' })).toBeNull();
    expect(readPlaceForm({ ...form, reason: 'x'.repeat(81) })).toBeNull();
    expect(readPlaceForm({ ...form, expiresInHours: 1.5 })).toBeNull();
    expect(readPlaceForm({ ...form, idempotencyKey: 'anything' })).toBeNull();
    expect(readPlaceForm({ ...form, idempotencyKey: 'console:hold:5f3c1d2e-0a1b-4c2d-8e3f-4a5b6c7d8e9f' })).toBeNull();
    // Another account's key is refused: a key belongs to the account it was read for.
    expect(readPlaceForm({ ...form, idempotencyKey: 'console:hold:5f3c1d2e-0a1b-4c2d-8e3f-4a5b6c7d8e9f:after:0' })).toBeNull();
    expect(readPlaceForm({ ...form, idempotencyKey: `console:hold:${USER}:after:07` })).toBeNull();
    expect(readPlaceForm({ ...form, extra: 1 })).toBeNull();
  });
});

describe('the place key', () => {
  it('is the account and the newest hold seen, so asking again before the list moves sends the same key', () => {
    expect(placeKey(USER, [])).toBe(`console:hold:${USER}:after:0`);
    expect(placeKey(USER, [{ holdNo: '9' }, { holdNo: '12' }, { holdNo: '3' }])).toBe(`console:hold:${USER}:after:12`);
    expect(placeKey(USER, [{ holdNo: '9223372036854775807' }])).toBe(`console:hold:${USER}:after:9223372036854775807`);
    expect(readPlaceForm({ ...form, idempotencyKey: placeKey(USER, [{ holdNo: '12' }]) })).not.toBeNull();
  });
});

describe('what the desk offers on a hold', () => {
  it('opens release and confirm only while something is held and nothing is settling', () => {
    expect(holdActionable(hold())).toBe(true);
    expect(holdActionable(hold({ state: 'partially_released', remaining: '25' }))).toBe(true);
    expect(holdActionable(hold({ state: 'released', remaining: '0' }))).toBe(false);
    const settling = hold();
    expect(holdActionable({ ...settling, movements: [{ ...settling.movements[0]!, status: 'settling' }] })).toBe(false);
  });

  it('describes each ledger post with who approved it and the ledger’s code', () => {
    const m = hold().movements[0]!;
    expect(movementLine(m)).toBe('Hold 1: 40, one founder, posted');
    expect(movementLine({ ...m, kind: 'release', no: '2', cause: 'expiry' })).toBe('Release 2: 40, the expiry, no approver, posted');
    expect(movementLine({ ...m, kind: 'confirm', status: 'refused', approverId: '22222222-aaaa', code: 'ledger.frozen' })).toBe(
      'Confirm 1: 40, approved by 22222222, refused (ledger.frozen)',
    );
  });
});

describe('what svc-ops answered to a hold action', () => {
  const result = (over: Partial<StaffHoldResult> = {}): StaffHoldResult => ({ hold: hold(), outcome: 'done', ...over });
  it('counts a posted action as done, naming what is still held', () => {
    expect(holdReply(result(), '1', 'release')).toEqual({ ok: true, detail: 'hold 1 is active, 40 USDT still held.' });
    expect(holdReply(result({ outcome: 'replayed' }), '1', 'release')).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/^Already done/),
    });
  });
  it('never calls a post still waiting for the ledger a success', () => {
    expect(holdReply(result({ outcome: 'settling' }), '1', 'confirm')).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
  it('refuses an answer about another hold', () => {
    expect(holdReply(result(), '2', 'release')).toMatchObject({ ok: false });
  });
});
