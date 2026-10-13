import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { firePaperSniperChildOnTrigger } from './oms-paper-sniper-fire.js';

const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TRIGGER = '100';
const QTY = '1.25';

describe('firePaperSniperChildOnTrigger', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      firePaperSniperChildOnTrigger({
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: '   ',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with status paper + last equal to trigger '100'", () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        kind: 'twap',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running / approved / omitted with not_live (this door is paper-only)', () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'running',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'approved',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses omitted / blank / invalid triggerPrice with missing_trigger even when last and amount are present', () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trigger' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: '',
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trigger' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: 'not-an-amount',
        lastPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_trigger' });
  });

  it('refuses omitted / blank / invalid lastPrice with missing_last even when trigger is present', () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_last' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: '   ',
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_last' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: 'not-an-amount',
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_last' });
  });

  it("refuses last '99' when trigger is '100' with trigger_not_hit (no invented hit)", () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: '99',
        amount: QTY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'trigger_not_hit' });
  });

  it('refuses omitted / blank amount with missing_qty (no invented size from the trigger)', () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: '',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_qty' });
  });

  it("refuses '0' / 'not-an-amount' with qty_invalid (no invented size from the trigger)", () => {
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: '0',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'qty_invalid' });
    expect(
      firePaperSniperChildOnTrigger({
        parentClientOrderId: 'p-snip',
        status: 'paper',
        triggerPrice: TRIGGER,
        lastPrice: TRIGGER,
        amount: 'not-an-amount',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'qty_invalid' });
  });

  it("happy: status paper + last '100' equals trigger '100' + amount '1.25' + paper on", () => {
    const result = firePaperSniperChildOnTrigger({
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      status: 'paper',
      triggerPrice: TRIGGER,
      lastPrice: TRIGGER,
      amount: QTY,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      fired: true,
      paper: true,
      parent: { parentClientOrderId: 'p-snip', kind: 'sniper' },
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
      lastPrice: formatAmount(parseAmount(TRIGGER)),
      amount: formatAmount(parseAmount(QTY)),
    });
    expect(result).not.toMatchObject({ amount: TRIGGER });
    expect(result).not.toHaveProperty('matching');
  });
});
