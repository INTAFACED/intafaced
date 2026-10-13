import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { cancelOtherPaperBracketExitOnFill } from './oms-paper-bracket-cancel-other.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TAKE_PROFIT = '101';
const STOP_LOSS = '99';

describe('cancelOtherPaperBracketExitOnFill', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      cancelOtherPaperBracketExitOnFill({
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      cancelOtherPaperBracketExitOnFill({
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

  it('paper unwired / paper_off refuse even with live paper + filled exit', () => {
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / oco with not_live', () => {
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        kind: 'oco',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'approved',
        filled: 'take_profit',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses omitted / blank / entry / unknown filled with missing_filled_exit', () => {
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_exit' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: '',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_exit' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: 'entry',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_exit' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: 'both',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_filled_exit' });
  });

  it('refuses omitted / blank / invalid takeProfit with missing_take_profit even when stopLoss and amount are present', () => {
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: 'take_profit',
        stopLoss: STOP_LOSS,
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        filled: 'stop_loss',
        takeProfit: TAKE_PROFIT,
        amount: '1000',
        remaining: '10',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
      cancelOtherPaperBracketExitOnFill({
        parentClientOrderId: 'p-brkt',
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
    const result = cancelOtherPaperBracketExitOnFill({
      parentClientOrderId: 'p-brkt',
      kind: 'bracket',
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
      parent: { parentClientOrderId: 'p-brkt', kind: 'bracket' },
      filled: 'take_profit',
      cancelledExit: 'stop_loss',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
      residual: { remaining: '10' },
    });
    expect(result).not.toMatchObject({ takeProfit: '1000' });
    expect(result).not.toMatchObject({ stopLoss: '1000' });
    expect(result).not.toHaveProperty('matching');
  });

  it('happy: stop_loss fills — cancel take_profit, residual stays', () => {
    const result = cancelOtherPaperBracketExitOnFill({
      parentClientOrderId: 'p-brkt',
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
      parent: { parentClientOrderId: 'p-brkt', kind: 'bracket' },
      filled: 'stop_loss',
      cancelledExit: 'take_profit',
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
      residual: { remaining: '10' },
    });
  });

  it('without remaining: residual.remaining null (not invented)', () => {
    const result = cancelOtherPaperBracketExitOnFill({
      parentClientOrderId: 'p-brkt',
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
      cancelledExit: 'stop_loss',
      residual: { remaining: null },
    });
  });
});
