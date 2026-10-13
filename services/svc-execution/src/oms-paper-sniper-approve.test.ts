import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { approvePaperSniperParent } from './oms-paper-sniper-approve.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const TRIGGER = '100';

describe('approvePaperSniperParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      approvePaperSniperParent({
        kind: 'sniper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      approvePaperSniperParent({
        parentClientOrderId: '   ',
        kind: 'sniper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with triggerPrice '100'", () => {
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: TRIGGER,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap / trailing-stop with not_live', () => {
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'twap',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'trailing-stop',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses missing / whitespace operator', () => {
    const missing = approvePaperSniperParent({
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      triggerPrice: TRIGGER,
      paper: PAPER_ON,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(missing).not.toMatchObject({ approved: true });
    const blank = approvePaperSniperParent({
      parentClientOrderId: 'p-snip',
      kind: 'sniper',
      triggerPrice: TRIGGER,
      operatorId: '   ',
      paper: PAPER_ON,
    });
    expect(blank).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(blank).not.toMatchObject({ approved: true });
  });

  it("refuses omitted / null / whitespace triggerPrice with trigger_blank even when amount is '1000'", () => {
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'trigger_blank' });
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: null,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'trigger_blank' });
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: '',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'trigger_blank' });
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: '   ',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'trigger_blank' });
  });

  it("refuses trigger '0', '-1', and '0.0' with trigger_blank and does not approve", () => {
    for (const triggerPrice of ['0', '-1', '0.0']) {
      const result = approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice,
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toMatchObject({ ok: false, reason: 'trigger_blank' });
      expect(result).not.toMatchObject({ approved: true });
    }
  });

  it("refuses 'not-an-amount' with trigger_invalid (no invented trigger from parent amount)", () => {
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: 'not-an-amount',
        amount: '1000',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'trigger_invalid' });
  });

  it("happy: parent id + kind sniper + triggerPrice '100' + operator + paper on", () => {
    expect(
      approvePaperSniperParent({
        parentClientOrderId: 'p-snip',
        kind: 'sniper',
        triggerPrice: TRIGGER,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      approved: true,
      paper: true,
      parent: { parentClientOrderId: 'p-snip', kind: 'sniper' },
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
  });

  it("happy: parent id + kind omitted + triggerPrice '100' + operator + paper on — not invented from amount", () => {
    const result = approvePaperSniperParent({
      parentClientOrderId: 'p-snip',
      triggerPrice: TRIGGER,
      amount: '1000',
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toEqual({
      ok: true,
      approved: true,
      paper: true,
      parent: { parentClientOrderId: 'p-snip', kind: 'sniper' },
      status: 'paper',
      triggerPrice: formatAmount(parseAmount(TRIGGER)),
    });
    expect(result).not.toMatchObject({ triggerPrice: '1000' });
    expect(result).not.toHaveProperty('matching');
  });
});
