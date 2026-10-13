import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { approvePaperStopLimitParent } from './oms-paper-stop-limit-approve.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const STOP = '100';
const LIMIT = '99';

describe('approvePaperStopLimitParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      approvePaperStopLimitParent({
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: '   ',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with stopPrice '100' and limitPrice '99'", () => {
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / sniper with not_live', () => {
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'twap',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'sniper',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses missing / whitespace operator', () => {
    const missing = approvePaperStopLimitParent({
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      stopPrice: STOP,
      limitPrice: LIMIT,
      paper: PAPER_ON,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(missing).not.toMatchObject({ approved: true });
    const blank = approvePaperStopLimitParent({
      parentClientOrderId: 'p-stpl',
      kind: 'stop-limit',
      stopPrice: STOP,
      limitPrice: LIMIT,
      operatorId: '   ',
      paper: PAPER_ON,
    });
    expect(blank).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(blank).not.toMatchObject({ approved: true });
  });

  it('refuses omitted / null / whitespace / invalid stopPrice with stop_blank / stop_invalid even when limit and amount are present', () => {
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_blank' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: null,
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_blank' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: '   ',
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_blank' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: 'not-an-amount',
        limitPrice: LIMIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_invalid' });
  });

  it('refuses omitted / null / whitespace / invalid limitPrice with limit_blank / limit_invalid even when stop and amount are present', () => {
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'limit_blank' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: null,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'limit_blank' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: '   ',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'limit_blank' });
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'limit_invalid' });
  });

  it("happy: parent id + kind stop-limit + stopPrice '100' + limitPrice '99' + operator + paper on", () => {
    expect(
      approvePaperStopLimitParent({
        parentClientOrderId: 'p-stpl',
        kind: 'stop-limit',
        stopPrice: STOP,
        limitPrice: LIMIT,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      approved: true,
      paper: true,
      parent: { parentClientOrderId: 'p-stpl', kind: 'stop-limit' },
      status: 'paper',
      stopPrice: formatAmount(parseAmount(STOP)),
      limitPrice: formatAmount(parseAmount(LIMIT)),
    });
  });

  it('happy: parent id + kind omitted + both prices + operator + paper on — not invented from amount', () => {
    const result = approvePaperStopLimitParent({
      parentClientOrderId: 'p-stpl',
      stopPrice: STOP,
      limitPrice: LIMIT,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      approved: true,
      paper: true,
      parent: { parentClientOrderId: 'p-stpl', kind: 'stop-limit' },
      status: 'paper',
      stopPrice: formatAmount(parseAmount(STOP)),
      limitPrice: formatAmount(parseAmount(LIMIT)),
    });
    expect(result).not.toMatchObject({ stopPrice: '1000' });
    expect(result).not.toMatchObject({ limitPrice: '1000' });
    expect(result).not.toHaveProperty('matching');
  });
});
