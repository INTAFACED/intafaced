import { describe, expect, it } from 'vitest';
import { slicePaperTwapParent } from './oms-paper-twap-slice.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;

describe('slicePaperTwapParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      slicePaperTwapParent({
        status: 'paper',
        amount: '1',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: '   ',
        status: 'paper',
        amount: '1',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with status paper + amount '1'", () => {
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        amount: '1',
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        amount: '1',
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind vwap with not_live', () => {
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        kind: 'vwap',
        status: 'paper',
        amount: '1',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running / approved / omitted with not_live (this door is paper-only)', () => {
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'running',
        amount: '1',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'approved',
        amount: '1',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        amount: '1',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses omitted / null / whitespace amount with missing_qty even when durationMs is 60_000 (no invented size from duration)', () => {
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        durationMs: 60_000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        amount: null,
        durationMs: 60_000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        amount: '',
        durationMs: 60_000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        amount: '   ',
        durationMs: 60_000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    const blank = slicePaperTwapParent({
      parentClientOrderId: 'p-twap',
      status: 'paper',
      amount: '',
      durationMs: 60_000,
      paper: PAPER_ON,
    });
    expect(blank).not.toHaveProperty('amount');
    expect(blank).not.toHaveProperty('sliced');
  });

  it("refuses 'nope' with qty_invalid", () => {
    expect(
      slicePaperTwapParent({
        parentClientOrderId: 'p-twap',
        status: 'paper',
        amount: 'nope',
        durationMs: 60_000,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'qty_invalid' });
  });

  it("refuses '0' with qty_invalid", () => {
    const zero = slicePaperTwapParent({
      parentClientOrderId: 'p-twap',
      status: 'paper',
      amount: '0',
      durationMs: 60_000,
      paper: PAPER_ON,
    });
    expect(zero).toMatchObject({ ok: false, reason: 'qty_invalid' });
    expect(zero).not.toMatchObject({ amount: '60000' });
    expect(zero).not.toHaveProperty('sliced');
  });

  it("happy: status paper + amount '1.25' + paper on + durationMs 60000 → sliced true, paper true, amount '1.25' (not invented from duration), kind twap", () => {
    const result = slicePaperTwapParent({
      parentClientOrderId: 'p-twap',
      kind: 'twap',
      status: 'paper',
      amount: '1.25',
      durationMs: 60000,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      sliced: true,
      paper: true,
      parent: { parentClientOrderId: 'p-twap', kind: 'twap' },
      amount: '1.25',
    });
    expect(result).not.toMatchObject({ amount: '60000' });
    if (result.ok) {
      expect(result.amount).toBe('1.25');
      expect(result.amount).not.toBe('60000');
      expect(result.paper).toBe(true);
      expect(result.parent.kind).toBe('twap');
    }
  });
});
