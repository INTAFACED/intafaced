import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperOcoParent } from './oms-paper-oco-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TAKE_PROFIT = '101';
const STOP_LOSS = '99';

describe('startPaperOcoParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperOcoParent({
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with approved paper + both siblings', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / pegged with not_live', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'twap',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'pegged',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'running',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const result = startPaperOcoParent({
      parentClientOrderId: 'p-oco',
      approved: true,
      status: 'running ',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_started' });
    expect(result).not.toMatchObject({ started: true });
  });

  it('refuses stopped and expired with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired'] as const) {
      const result = startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(result).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: false,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid takeProfit with missing_take_profit even when stopLoss and amount are present', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: '',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: 'not-an-amount',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
  });

  it('refuses omitted / blank / invalid stopLoss with missing_stop_loss even when takeProfit and amount are present', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
  });

  it("happy: status paper + takeProfit '101' + stopLoss '99' + operator + paper on — both siblings go live, status stays paper", () => {
    const started = startPaperOcoParent({
      parentClientOrderId: 'p-oco',
      status: 'paper',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      status: 'paper',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it('happy: approved true + status paper + both siblings + operator + paper on', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      status: 'paper',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
  });

  it('happy: approved true + status approved + both siblings + operator + paper on', () => {
    expect(
      startPaperOcoParent({
        parentClientOrderId: 'p-oco',
        approved: true,
        status: 'approved',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      status: 'paper',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
  });

  it('happy: approved true + both siblings + operator + paper on (status omitted) — not invented from amount', () => {
    const started = startPaperOcoParent({
      parentClientOrderId: 'p-oco',
      approved: true,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      status: 'paper',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
    expect(started).not.toMatchObject({ takeProfit: '1000' });
    expect(started).not.toMatchObject({ stopLoss: '1000' });
  });
});
