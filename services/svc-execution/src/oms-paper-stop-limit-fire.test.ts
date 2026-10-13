import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { firePaperStopLimitLimitChildOnStop } from './oms-paper-stop-limit-fire.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const STOP = '100';
const LIMIT = '99';
const QTY = '1.25';

describe('firePaperStopLimitLimitChildOnStop', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: '   ',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with status paper + last equal to stop '100'", () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        kind: 'twap',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running / approved / omitted with not_live (this door is paper-only)', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'running',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'approved',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses omitted / blank / invalid stopPrice with missing_stop even when last, limit, and amount are present', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: '',
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: 'not-an-amount',
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop' });
  });

  it('refuses omitted / blank / invalid lastPrice with missing_last even when stop is present', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_last' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: '   ',
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_last' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: 'not-an-amount',
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_last' });
  });

  it("refuses last '99' (the limit) when stop is '100' with stop_not_hit (no invented hit from the other price)", () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: LIMIT,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_not_hit' });
  });

  it('refuses omitted / blank / invalid limitPrice with missing_limit even when last equals the stop', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_limit' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: '',
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_limit' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: 'not-an-amount',
        lastPrice: STOP,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_limit' });
  });

  it('refuses omitted / blank amount with missing_qty (no invented size from the stop or the limit)', () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: '',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
  });

  it("refuses '0' / 'not-an-amount' with qty_invalid (no invented size from the stop or the limit)", () => {
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: '0',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'qty_invalid' });
    expect(
      firePaperStopLimitLimitChildOnStop({
        parentClientOrderId: 'p-stpl',
        status: 'paper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        lastPrice: STOP,
        amount: 'not-an-amount',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'qty_invalid' });
  });

  it("happy: status paper + last '100' equals stop '100' + limit '99' + amount '1.25' + paper on — child is limit, not matching", () => {
    const result = firePaperStopLimitLimitChildOnStop({
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      status: 'paper',
      stopPrice: STOP,
      limitPrice: LIMIT,
      lastPrice: STOP,
      amount: QTY,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      fired: true,
      paper: true,
      parent: { parentClientOrderId: 'p-stpl', kind: 'stop-limit' },
      stopPrice: formatAmount(parseAmount(STOP)),
      lastPrice: formatAmount(parseAmount(STOP)),
      child: {
        kind: 'limit',
        limitPrice: formatAmount(parseAmount(LIMIT)),
        amount: formatAmount(parseAmount(QTY)),
      },
    });
    expect(result).not.toMatchObject({ child: { amount: STOP } });
    expect(result).not.toMatchObject({ child: { limitPrice: STOP } });
    expect(result).not.toHaveProperty('matching');
  });
});
