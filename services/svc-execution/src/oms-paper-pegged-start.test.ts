import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperPeggedParent } from './oms-paper-pegged-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const OFFSET = '0.05';

describe('startPaperPeggedParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperPeggedParent({
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperPeggedParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + offset '0.05'", () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        kind: 'twap',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'running',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const result = startPaperPeggedParent({
      parentClientOrderId: 'p-peg',
      approved: true,
      status: 'running ',
      offset: OFFSET,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_started' });
    expect(result).not.toMatchObject({ started: true });
  });

  it('refuses stopped and expired with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired'] as const) {
      const result = startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status,
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(result).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: false,
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / invalid offset with missing_offset', () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_offset' });
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: '',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_offset' });
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: 'not-an-amount',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_offset' });
  });

  it("happy: status paper + offset '0.05' + operator + paper on", () => {
    const started = startPaperPeggedParent({
      parentClientOrderId: 'p-peg',
      status: 'paper',
      offset: OFFSET,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-peg',
      kind: 'pegged',
      status: 'paper',
      offset: formatAmount(parseAmount(OFFSET)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it("happy: approved true + status paper + offset '0.05' + operator + paper on", () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'paper',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-peg',
      kind: 'pegged',
      status: 'paper',
      offset: formatAmount(parseAmount(OFFSET)),
    });
  });

  it("happy: approved true + status approved + offset '0.05' + operator + paper on", () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        status: 'approved',
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-peg',
      kind: 'pegged',
      status: 'paper',
      offset: formatAmount(parseAmount(OFFSET)),
    });
  });

  it("happy: approved true + offset '0.05' + operator + paper on (status omitted)", () => {
    expect(
      startPaperPeggedParent({
        parentClientOrderId: 'p-peg',
        approved: true,
        offset: OFFSET,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-peg',
      kind: 'pegged',
      status: 'paper',
      offset: formatAmount(parseAmount(OFFSET)),
    });
  });
});
