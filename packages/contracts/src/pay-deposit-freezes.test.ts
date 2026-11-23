import { describe, expect, it } from 'vitest';
import {
  depositFreezeAnswerSchema,
  depositFreezeResultSchema,
  depositUnfreezeAnswerSchema,
  depositUnfreezeResultSchema,
} from './pay-deposit-freezes.js';

const view = {
  id: '7d8c9b0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
  userId: '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  networkId: 'ethereum',
  address: '0x00000000000000000000000000000000000000a1',
  reason: 'compliance review of the source',
  frozenBy: 'founder-a',
  frozenAt: '2026-11-13T00:00:00.000Z',
  unfrozenBy: null,
  unfreezeApprover: null,
  unfreezeReason: null,
  unfrozenAt: null,
};
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe('what svc-pay declares it sends', () => {
  it('is strict: every view field, nothing extra', () => {
    expect(ok(depositFreezeResultSchema, { freeze: view, held: 0, creditedUntouched: 0 })).toBe(true);
    expect(ok(depositFreezeResultSchema, { freeze: { ...view, extra: 1 }, held: 0, creditedUntouched: 0 })).toBe(false);
    const { reason: _r, ...noReason } = view;
    expect(ok(depositUnfreezeResultSchema, { freeze: noReason, released: 0, credited: 0 })).toBe(false);
  });
});

describe('what a reader accepts', () => {
  it('accepts what svc-pay sends', () => {
    expect(ok(depositFreezeAnswerSchema, { freeze: view, held: 2, creditedUntouched: 1 })).toBe(true);
    expect(ok(depositUnfreezeAnswerSchema, { freeze: view, released: 3, credited: 3 })).toBe(true);
  });

  it('refuses a negative, fractional, unsafe or non-number count', () => {
    for (const held of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(ok(depositFreezeAnswerSchema, { freeze: view, held, creditedUntouched: 0 }), String(held)).toBe(false);
      expect(ok(depositUnfreezeAnswerSchema, { freeze: view, released: held, credited: 0 }), String(held)).toBe(false);
    }
    expect(ok(depositFreezeAnswerSchema, { freeze: view, held: 0, creditedUntouched: -1 })).toBe(false);
  });

  it('refuses more deposits credited than released', () => {
    expect(ok(depositUnfreezeAnswerSchema, { freeze: view, released: 1, credited: 2 })).toBe(false);
  });

  it('refuses an answer without its freeze, or a freeze missing a field the console reads', () => {
    expect(ok(depositFreezeAnswerSchema, { held: 0, creditedUntouched: 0 })).toBe(false);
    for (const field of ['id', 'userId', 'networkId', 'address'] as const) {
      const { [field]: _drop, ...rest } = view;
      expect(ok(depositFreezeAnswerSchema, { freeze: rest, held: 0, creditedUntouched: 0 }), field).toBe(false);
      expect(ok(depositUnfreezeAnswerSchema, { freeze: { ...view, [field]: 1 }, released: 0, credited: 0 }), field).toBe(false);
    }
  });

  it('ignores a field it does not read, so a newer service does not break an older console', () => {
    const r = depositFreezeAnswerSchema.safeParse({ freeze: { ...view, later: 'x' }, held: 0, creditedUntouched: 0, later: 1 });
    expect(r.success).toBe(true);
  });
});
