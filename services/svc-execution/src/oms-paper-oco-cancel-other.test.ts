import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { cancelOtherPaperOcoSiblingOnFill } from './oms-paper-oco-cancel-other.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TAKE_PROFIT = '101';
const STOP_LOSS = '99';

describe('cancelOtherPaperOcoSiblingOnFill', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: '   ',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with live paper + filled sibling', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / pegged with not_live', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        kind: 'twap',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        kind: 'pegged',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status stopped with already_stopped', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'stopped',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses status running with not_running (do not invent paper cancel over live)', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'running',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses omitted / approved status with not_running', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'approved',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses omitted / blank / unknown filled sibling with missing_filled_sibling', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_sibling' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: '',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_sibling' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'both',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_sibling' });
  });

  it('refuses omitted / blank / invalid takeProfit with missing_take_profit even when stopLoss and amount are present', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'take_profit',
        stopLoss: STOP_LOSS,
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'stop_loss',
        takeProfit: '',
        stopLoss: STOP_LOSS,
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: 'not-an-amount',
        stopLoss: STOP_LOSS,
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
  });

  it('refuses omitted / blank / invalid stopLoss with missing_stop_loss even when takeProfit and amount are present', () => {
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'stop_loss',
        takeProfit: TAKE_PROFIT,
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: '',
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      cancelOtherPaperOcoSiblingOnFill({
        parentClientOrderId: 'p-oco',
        status: 'paper',
        filled: 'stop_loss',
        takeProfit: TAKE_PROFIT,
        stopLoss: 'not-an-amount',
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
  });

  it('happy: take_profit fills — cancel stop_loss, residual stays, triggers not invented from amount', () => {
    const result = cancelOtherPaperOcoSiblingOnFill({
      parentClientOrderId: 'p-oco',
      kind: 'oco',
      status: 'paper',
      filled: 'take_profit',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      amount: '1000',
      remaining: '10',
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      cancelled: true,
      paper: true,
      parent: { parentClientOrderId: 'p-oco', kind: 'oco' },
      filled: 'take_profit',
      cancelledSibling: 'stop_loss',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
      residual: { remaining: '10' },
    });
    expect(result).not.toMatchObject({ takeProfit: '1000' });
    expect(result).not.toMatchObject({ stopLoss: '1000' });
    expect(result).not.toHaveProperty('matching');
  });

  it('happy: stop_loss fills — cancel take_profit, residual stays', () => {
    const result = cancelOtherPaperOcoSiblingOnFill({
      parentClientOrderId: 'p-oco',
      status: 'paper',
      filled: 'stop_loss',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      remaining: '10',
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      cancelled: true,
      paper: true,
      parent: { parentClientOrderId: 'p-oco', kind: 'oco' },
      filled: 'stop_loss',
      cancelledSibling: 'take_profit',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
      residual: { remaining: '10' },
    });
  });

  it('without remaining: residual.remaining null (not invented)', () => {
    const result = cancelOtherPaperOcoSiblingOnFill({
      parentClientOrderId: 'p-oco',
      status: 'paper',
      filled: 'take_profit',
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({
      ok: true,
      cancelled: true,
      paper: true,
      filled: 'take_profit',
      cancelledSibling: 'stop_loss',
      residual: { remaining: null },
    });
  });
});
