import { describe, expect, it } from 'vitest';
import { draftPayload, readLaunchEventPayload, readTrails, type LaunchDraftForm } from './model';

const FORM: LaunchDraftForm = {
  id: 'test-launch',
  issuerId: 'test-issuer',
  type: 'token_sale',
  projectName: 'TEST Project',
  symbol: 'TST',
  periods: ['2026-11-01T00:00', '2026-11-01T01:00', '2026-11-01T02:00', '2026-11-01T10:00', '2026-11-01T11:00'],
  method: 'pro_rata',
  perUserCap: '250',
  ticketSize: '',
  price: '0.5',
  paymentAsset: 'USDT',
  rateSource: '',
};

const refused = (patch: Partial<LaunchDraftForm>) => {
  const out = draftPayload({ ...FORM, ...patch });
  return out.ok ? null : out.message;
};

describe('the new-launch form refuses what svc-token would refuse, before two founders spend an approval', () => {
  it('a valid form gives svc-token’s canonical payload, read back strictly', () => {
    const out = draftPayload(FORM);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(readLaunchEventPayload(out.event)).toMatchObject({
      id: 'test-launch',
      periods: ['2026-11-01T00:00:00.000Z', ...Array(4).fill(expect.any(String))],
    });
  });

  it('periods out of order, a zero amount, a price without its currency, or a rate source without a price', () => {
    expect(
      refused({ periods: ['2026-11-01T02:00', '2026-11-01T01:00', '2026-11-01T02:00', '2026-11-01T10:00', '2026-11-01T11:00'] }),
    ).toMatch(/in that order/);
    expect(
      refused({ periods: ['2026-11-01T00:00', '2026-11-01T01:00', '2026-11-01T10:00', '2026-11-01T10:00', '2026-11-01T11:00'] }),
    ).toMatch(/close after open/);
    expect(refused({ price: '0' })).toMatch(/more than zero/);
    expect(refused({ perUserCap: '0.0' })).toMatch(/no extra zeros|more than zero/);
    expect(refused({ paymentAsset: '' })).toMatch(/currency/);
    expect(refused({ price: '', paymentAsset: '', rateSource: 'TEST feed' })).toMatch(/rate source needs a price/);
    expect(refused({ price: '0.50' })).toMatch(/no extra zeros/);
    expect(refused({ id: 'X' })).toMatch(/Launch id/);
  });

  it('a payload svc-token would hash differently is not read: untrimmed rate source, reordered keys', () => {
    const out = draftPayload({ ...FORM, rateSource: 'TEST feed' });
    if (!out.ok) throw new Error(out.message);
    expect(readLaunchEventPayload(out.event.replace('"TEST feed"', '" TEST feed"'))).toBeNull();
    const parsed = JSON.parse(out.event) as Record<string, unknown>;
    const { id, ...rest } = parsed;
    expect(readLaunchEventPayload(JSON.stringify({ ...rest, id }))).toBeNull();
  });

  it('reads trails keyed by id and refuses a malformed one', () => {
    const move = { ordinal: 1, from: null, to: 'applied', actorId: 'a', approverId: 'b', cause: null, at: '2026-11-01T00:00:00.000Z' };
    expect(readTrails({ x: [move] })).toEqual({ x: [move] });
    expect(readTrails({ x: [{ ...move, ordinal: 'one' }] })).toBeNull();
    expect(readTrails([move])).toBeNull();
  });
});
