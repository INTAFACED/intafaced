import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { approvePaperOcoParent } from './oms-paper-oco-approve.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TAKE_PROFIT = '101';
const STOP_LOSS = '99';

describe('approvePaperOcoParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      approvePaperOcoParent({
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: '   ',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with both siblings present', () => {
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / pegged with not_live', () => {
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'twap',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'pegged',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses missing / whitespace operator', () => {
    const missing = approvePaperOcoParent({
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      paper: PAPER_ON,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(missing).not.toMatchObject({ approved: true });
    const blank = approvePaperOcoParent({
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      operatorId: '   ',
      paper: PAPER_ON,
    });
    expect(blank).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(blank).not.toMatchObject({ approved: true });
  });

  it('refuses omitted / null / whitespace takeProfit with take_profit_blank even when stopLoss and amount are present', () => {
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'take_profit_blank' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: null,
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'take_profit_blank' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: '',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'take_profit_blank' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: '   ',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'take_profit_blank' });
  });

  it('refuses omitted / null / whitespace stopLoss with stop_loss_blank even when takeProfit and amount are present', () => {
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_loss_blank' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: null,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_loss_blank' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_loss_blank' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: '   ',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_loss_blank' });
  });

  it("refuses take-profit '0' with take_profit_blank and does not approve, even when stop-loss is positive", () => {
    const result = approvePaperOcoParent({
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      takeProfit: '0',
      stopLoss: STOP_LOSS,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'take_profit_blank' });
    expect(result).not.toMatchObject({ approved: true });
  });

  it("refuses stop-loss '0', '0.0', '-1', and a negative decimal with stop_loss_blank and does not approve, even when take-profit is positive", () => {
    for (const stopLoss of ['0', '0.0', '-1', '-1.5']) {
      const result = approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toMatchObject({ ok: false, reason: 'stop_loss_blank' });
      expect(result).not.toMatchObject({ approved: true });
    }
  });

  it("refuses 'not-an-amount' siblings with take_profit_invalid / stop_loss_invalid (no invented trigger)", () => {
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: 'not-an-amount',
        stopLoss: STOP_LOSS,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'take_profit_invalid' });
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'stop_loss_invalid' });
  });

  it("happy: parent id + kind oco + takeProfit '101' + stopLoss '99' + operator + paper on", () => {
    expect(
      approvePaperOcoParent({
        parentClientOrderId: 'p-oco',
        kind: 'oco',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      approved: true,
      paper: true,
      parent: { parentClientOrderId: 'p-oco', kind: 'oco' },
      status: 'paper',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
  });

  it('happy: parent id + kind omitted + both siblings + operator + paper on — not invented from amount', () => {
    const result = approvePaperOcoParent({
      parentClientOrderId: 'p-oco',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      approved: true,
      paper: true,
      parent: { parentClientOrderId: 'p-oco', kind: 'oco' },
      status: 'paper',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
    expect(result).not.toMatchObject({ takeProfit: '1000' });
    expect(result).not.toMatchObject({ stopLoss: '1000' });
  });
});
