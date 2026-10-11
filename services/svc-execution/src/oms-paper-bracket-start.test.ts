import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperBracketParent } from './oms-paper-bracket-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const ENTRY = '100';
const TAKE_PROFIT = '101';
const STOP_LOSS = '99';

describe('startPaperBracketParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperBracketParent({
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with approved paper + all three legs', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / oco with not_live', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        kind: 'twap',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        kind: 'oco',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'running',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: false,
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid entry with missing_entry even when takeProfit, stopLoss, and amount are present', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_entry' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: '',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_entry' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: 'not-an-amount',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_entry' });
  });

  it("refuses entry '0' with missing_entry even when takeProfit and stopLoss are positive, and does not start", () => {
    const started = startPaperBracketParent({
      parentClientOrderId: 'p-brkt',
      approved: true,
      status: 'paper',
      entry: '0',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toMatchObject({ ok: false, reason: 'missing_entry' });
    expect(started).not.toMatchObject({ started: true });
  });

  it('refuses zero and negative entry with missing_entry even when the other legs are positive', () => {
    for (const entry of ['0.0', '-1', '-1.25']) {
      const started = startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'missing_entry' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted / blank / invalid takeProfit with missing_take_profit even when entry, stopLoss, and amount are present', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: '',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: 'not-an-amount',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
  });

  it('refuses zero and negative takeProfit with missing_take_profit even when the other legs are positive', () => {
    for (const takeProfit of ['0', '0.0', '-1', '-1.25']) {
      const started = startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'missing_take_profit' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted / blank / invalid stopLoss with missing_stop_loss even when entry, takeProfit, and amount are present', () => {
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
  });

  it('refuses zero and negative stopLoss with missing_stop_loss even when the other legs are positive', () => {
    for (const stopLoss of ['0', '0.0', '-1', '-1.25']) {
      const started = startPaperBracketParent({
        parentClientOrderId: 'p-brkt',
        approved: true,
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(started).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
      expect(started).not.toMatchObject({ started: true });
    }
  });

  it("happy: status paper + entry '100' + takeProfit '101' + stopLoss '99' + operator + paper on — all three legs go live, status stays paper", () => {
    const started = startPaperBracketParent({
      parentClientOrderId: 'p-brkt',
      status: 'paper',
      entry: ENTRY,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-brkt',
      kind: 'bracket',
      status: 'paper',
      entry: formatAmount(parseAmount(ENTRY)),
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it('happy: approved true + all three legs + operator + paper on (status omitted) — not invented from amount', () => {
    const started = startPaperBracketParent({
      parentClientOrderId: 'p-brkt',
      approved: true,
      entry: ENTRY,
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
      parentClientOrderId: 'p-brkt',
      kind: 'bracket',
      status: 'paper',
      entry: formatAmount(parseAmount(ENTRY)),
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
    expect(started).not.toMatchObject({ entry: '1000' });
    expect(started).not.toMatchObject({ takeProfit: '1000' });
    expect(started).not.toMatchObject({ stopLoss: '1000' });
    expect(started).not.toHaveProperty('matching');
  });
});
