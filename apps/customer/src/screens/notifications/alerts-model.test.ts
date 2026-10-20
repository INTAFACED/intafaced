import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../shared/api';
import {
  cancelWords,
  createGate,
  evaluationNote,
  expiryIso,
  expiryProblem,
  findDuplicate,
  priceProblem,
  samePrice,
  settleFailure,
  settleUnknownCreate,
  validPrice,
} from './alerts-model';
import type { AlertIntent, PriceAlert } from './notify-api';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;
const failure = (patch: Partial<Failure>): Failure => ({ ok: false, reason: 'error', message: 'x', ...patch });
const alert = (patch: Partial<PriceAlert> = {}): PriceAlert => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  marketId: 'm1',
  kind: 'price',
  direction: 'above',
  targetPrice: '65000.50',
  status: 'active',
  firedAt: null,
  createdAt: '2026-10-17T08:00:00.000Z',
  ...patch,
});
const intent: AlertIntent = { marketId: 'm1', direction: 'above', targetPrice: '65000.5' };

describe('price entry', () => {
  it('accepts exact positive decimals and nothing else', () => {
    for (const ok of ['1', '0.0001', '65000.50', ' 12.5 ', '00012', '123456789012345678901234567890.123456789012345678'])
      expect(validPrice(ok), ok).toBe(true);
    for (const bad of ['', ' ', '0', '0.000', '-1', '+1', '1e5', '1,000', '1.', '.5', '1.2.3', 'abc', '١٢', `${'9'.repeat(65)}`])
      expect(validPrice(bad), bad).toBe(false);
  });

  it('tells a blank price from a wrong one', () => {
    expect(priceProblem('')).toBe('empty');
    expect(priceProblem('  ')).toBe('empty');
    expect(priceProblem('abc')).toBe('invalid');
    expect(priceProblem('10')).toBeNull();
  });

  it('compares spellings of the same number without turning them into numbers', () => {
    expect(samePrice('100.50', '100.5')).toBe(true);
    expect(samePrice('0100', '100')).toBe(true);
    expect(samePrice('100.51', '100.5')).toBe(false);
    // Beyond the safe range of a JS number, the digits still decide.
    expect(samePrice('9007199254740993', '9007199254740992')).toBe(false);
  });
});

describe('what the platform can do', () => {
  it('says plainly when no alert can trigger, and why', () => {
    expect(evaluationNote({ markSource: 'live', canFire: true, code: null })).toBe('evalReady');
    expect(evaluationNote({ markSource: 'dark', canFire: false, code: 'alert.price_unavailable' })).toBe('evalDark');
    expect(evaluationNote({ markSource: 'live', canFire: false, code: 'channel.not_configured' })).toBe('evalNoDelivery');
    expect(evaluationNote({ markSource: 'live', canFire: false, code: 'channel.disabled' })).toBe('evalNoDelivery');
  });
});

describe('duplicates', () => {
  it('finds only an active alert for the same market, side and price', () => {
    expect(findDuplicate([alert()], intent)?.id).toBe(alert().id);
    expect(findDuplicate([alert({ status: 'cancelled' })], intent)).toBeNull();
    expect(findDuplicate([alert({ status: 'fired', firedAt: '2026-10-17T09:00:00.000Z' })], intent)).toBeNull();
    expect(findDuplicate([alert({ direction: 'below' })], intent)).toBeNull();
    expect(findDuplicate([alert({ marketId: 'm2' })], intent)).toBeNull();
    expect(findDuplicate([alert({ kind: 'funding' })], intent)).toBeNull();
  });
});

describe('refusal mapping', () => {
  it('turns what the service said into a plain refusal, nothing changed', () => {
    expect(settleFailure(failure({ reason: 'unauthorized', status: 401 }))).toEqual({ kind: 'refused', refusal: 'signedOut' });
    expect(settleFailure(failure({ reason: 'forbidden', status: 403 }))).toEqual({ kind: 'refused', refusal: 'notAllowed' });
    expect(settleFailure(failure({ reason: 'not_mounted', status: 404 }))).toEqual({ kind: 'refused', refusal: 'notOn' });
    expect(settleFailure(failure({ reason: 'not_supported', status: 501 }))).toEqual({ kind: 'refused', refusal: 'notOn' });
    expect(settleFailure(failure({ reason: 'aborted' }))).toEqual({ kind: 'refused', refusal: 'accountChanged' });
    expect(settleFailure(failure({ status: 429 }))).toEqual({ kind: 'refused', refusal: 'tooMany' });
    expect(settleFailure(failure({ status: 412, code: 'PRECONDITION_FAILED', message: 'alert.price_unavailable' }))).toEqual({
      kind: 'refused',
      refusal: 'notOn',
    });
    expect(settleFailure(failure({ status: 412, code: 'notify.price_unset', message: 'A price alert is refused.' }))).toEqual({
      kind: 'refused',
      refusal: 'priceMissing',
    });
    expect(settleFailure(failure({ status: 412, message: 'alert.kind_unpublished: intelligence has no sourced series' }))).toEqual({
      kind: 'refused',
      refusal: 'unpublished',
    });
    expect(settleFailure(failure({ status: 412, message: 'alert.portfolio_view_unpublished: ledger portfolio view unpublished' }))).toEqual(
      {
        kind: 'refused',
        refusal: 'unpublished',
      },
    );
    expect(settleFailure(failure({ status: 400, code: 'BAD_REQUEST', message: 'Invalid input' }))).toEqual({
      kind: 'refused',
      refusal: 'badRequest',
    });
    expect(settleFailure(failure({ status: 422, message: 'whatever' }))).toEqual({ kind: 'refused', refusal: 'other' });
  });

  it('never calls a lost, errored or unverifiable answer failed: it is unknown', () => {
    expect(settleFailure(failure({ reason: 'uncertain' }))).toEqual({ kind: 'unknown' });
    expect(settleFailure(failure({ reason: 'uncertain', status: 500 }))).toEqual({ kind: 'unknown' });
    expect(settleFailure(failure({ reason: 'invalid_response' }))).toEqual({ kind: 'unknown' });
    expect(settleFailure(failure({ reason: 'unreachable' }))).toEqual({ kind: 'unknown' });
  });
});

describe('a lost answer to save', () => {
  it('counts the alert as saved only when a NEW matching active alert appears', () => {
    const before = new Set(['old']);
    const fresh = alert({ id: '22222222-2222-4222-8222-222222222222' });
    expect(settleUnknownCreate(before, intent, [fresh])?.id).toBe(fresh.id);
    // An alert that was already there does not prove this attempt landed.
    expect(settleUnknownCreate(new Set([fresh.id]), intent, [fresh])).toBeNull();
    expect(settleUnknownCreate(before, intent, [])).toBeNull();
    expect(settleUnknownCreate(before, intent, [alert({ id: '33333333-3333-4333-8333-333333333333', direction: 'below' })])).toBeNull();
  });
});

describe('cancel answers', () => {
  it('words each answer', () => {
    expect(cancelWords({ cancelled: true, alert: { status: 'cancelled' } })).toBe('cancelled');
    expect(cancelWords({ cancelled: false, alert: { status: 'fired' } })).toBe('alreadyFired');
    expect(cancelWords({ cancelled: false, alert: { status: 'cancelled' } })).toBe('alreadyCancelled');
    expect(cancelWords({ cancelled: false, alert: null })).toBe('notFound');
  });
});

describe('one change at a time', () => {
  it('turns a second entry away until the first leaves', () => {
    const gate = createGate();
    expect(gate.enter()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.enter()).toBe(false);
    gate.leave();
    expect(gate.busy).toBe(false);
    expect(gate.enter()).toBe(true);
  });
});

describe('crossing, name, message and expiry', () => {
  it('maps the owner-limit refusals to plain words, nothing changed', () => {
    const say = (status: number, message: string) => settleFailure(failure({ status, message }));
    expect(say(400, 'alert.text_too_long: name is over 40')).toEqual({ kind: 'refused', refusal: 'textRejected' });
    expect(say(400, 'alert.message_placeholder_unknown: {x} is not a placeholder')).toEqual({ kind: 'refused', refusal: 'textRejected' });
    expect(say(400, 'alert.expiry_in_past: expiry must be in the future')).toEqual({ kind: 'refused', refusal: 'expiryRejected' });
    expect(say(400, 'alert.expiry_too_far: more than 30 days')).toEqual({ kind: 'refused', refusal: 'expiryRejected' });
    expect(say(412, 'notify.alert_text_limit_unset: needs the owner')).toEqual({ kind: 'refused', refusal: 'optionNotOn' });
    expect(say(412, 'notify.alert_expiry_max_unset: needs the owner')).toEqual({ kind: 'refused', refusal: 'optionNotOn' });
  });

  it('accepts a blank expiry, refuses one that is not a real moment, and sends an exact instant', () => {
    expect(expiryProblem('')).toBeNull();
    expect(expiryIso('')).toBeUndefined();
    expect(expiryProblem('not a date')).toBe('invalid');
    expect(expiryIso('not a date')).toBeUndefined();
    expect(expiryProblem('2026-11-01T09:30')).toBeNull();
    expect(expiryIso('2026-11-01T09:30')).toBe(new Date('2026-11-01T09:30').toISOString());
  });

  it('treats a different condition, name, message or expiry as a different alert', () => {
    const level = alert({ condition: 'greater_than' });
    const base: AlertIntent = { marketId: 'm1', direction: 'above', condition: 'greater_than', targetPrice: '65000.5' };
    expect(findDuplicate([level], base)).not.toBeNull();
    expect(findDuplicate([level], { ...base, condition: 'crossing_up' })).toBeNull();
    expect(findDuplicate([level], { ...base, name: 'Breakout' })).toBeNull();
    expect(
      findDuplicate([alert({ condition: 'crossing_up', name: 'Breakout' })], { ...base, condition: 'crossing_up', name: 'Breakout' }),
    ).not.toBeNull();
  });
});
