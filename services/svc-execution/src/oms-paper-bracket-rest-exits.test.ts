import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { restPaperBracketExitsOnEntryFill } from './oms-paper-bracket-rest-exits.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const ENTRY = '100';
const TAKE_PROFIT = '101';
const STOP_LOSS = '99';

describe('restPaperBracketExitsOnEntryFill', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: '   ',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it('paper unwired / paper_off refuse even with live paper + all three legs', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / oco with not_live', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        kind: 'twap',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        kind: 'oco',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status stopped with already_stopped', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'stopped',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_stopped' });
  });

  it('refuses status running with not_running (do not invent paper rest over live)', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'running',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses omitted / approved status with not_running', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'approved',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_running' });
  });

  it('refuses omitted / blank / invalid entry with missing_entry even when takeProfit, stopLoss, and amount are present', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_entry' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: '',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_entry' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: 'not-an-amount',
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_entry' });
  });

  it('refuses omitted / blank / invalid takeProfit with missing_take_profit even when entry, stopLoss, and amount are present', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        stopLoss: STOP_LOSS,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: '',
        stopLoss: STOP_LOSS,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: 'not-an-amount',
        stopLoss: STOP_LOSS,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_take_profit' });
  });

  it('refuses omitted / blank / invalid stopLoss with missing_stop_loss even when entry, takeProfit, and amount are present', () => {
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: '',
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
    expect(
      restPaperBracketExitsOnEntryFill({
        parentClientOrderId: 'p-brkt',
        status: 'paper',
        entry: ENTRY,
        takeProfit: TAKE_PROFIT,
        stopLoss: 'not-an-amount',
        amount: '1000',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_stop_loss' });
  });

  it('happy: entry fills — rest take_profit and stop_loss, triggers not invented from amount', () => {
    const result = restPaperBracketExitsOnEntryFill({
      parentClientOrderId: 'p-brkt',
      kind: 'bracket',
      status: 'paper',
      entry: ENTRY,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      amount: '1000',
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      rested: true,
      paper: true,
      parent: { parentClientOrderId: 'p-brkt', kind: 'bracket' },
      filled: 'entry',
      restedLegs: ['take_profit', 'stop_loss'],
      entry: formatAmount(parseAmount(ENTRY)),
      takeProfit: formatAmount(parseAmount(TAKE_PROFIT)),
      stopLoss: formatAmount(parseAmount(STOP_LOSS)),
    });
    expect(result).not.toMatchObject({ entry: '1000' });
    expect(result).not.toMatchObject({ takeProfit: '1000' });
    expect(result).not.toMatchObject({ stopLoss: '1000' });
    expect(result).not.toHaveProperty('matching');
  });

  it('restedLegs is always both take_profit and stop_loss — never one-sided', () => {
    const result = restPaperBracketExitsOnEntryFill({
      parentClientOrderId: 'p-brkt',
      status: 'paper',
      entry: ENTRY,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({
      ok: true,
      filled: 'entry',
      restedLegs: ['take_profit', 'stop_loss'],
    });
  });
});
