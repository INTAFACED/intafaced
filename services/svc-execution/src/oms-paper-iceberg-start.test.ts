import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { startPaperIcebergParent } from './oms-paper-iceberg-start.js';

const OP = '33333333-3333-4333-8333-333333333333';
const PAPER_ON = { enabled: true } as const;
const PAPER_OFF = { enabled: false } as const;
const DISPLAY = '100';

describe('startPaperIcebergParent', () => {
  it('refuses missing / whitespace parentClientOrderId', () => {
    expect(
      startPaperIcebergParent({
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
    expect(
      startPaperIcebergParent({
        parentClientOrderId: '   ',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_parent' });
  });

  it("paper unwired / paper_off refuse even with approved paper + displayQty '100'", () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: OP,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_gate_unwired' });
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_OFF,
      }),
    ).toMatchObject({ ok: false, reason: 'paper_off' });
  });

  it('refuses kind twap with not_live', () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        kind: 'twap',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_live' });
  });

  it('refuses status running with already_started', () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'running',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'already_started' });
  });

  it("refuses padded status 'running ' with already_started and does not start", () => {
    const result = startPaperIcebergParent({
      parentClientOrderId: 'p-ice',
      approved: true,
      status: 'running ',
      displayQty: DISPLAY,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(result).toMatchObject({ ok: false, reason: 'already_started' });
    expect(result).not.toMatchObject({ started: true });
  });

  it('refuses stopped and expired with not_approved even when approved is true', () => {
    for (const status of ['stopped', 'expired'] as const) {
      const result = startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status,
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      });
      expect(result).toMatchObject({ ok: false, reason: 'not_approved' });
      expect(result).not.toMatchObject({ started: true });
    }
  });

  it('refuses omitted status and approved:false with not_approved', () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: false,
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'not_approved' });
  });

  it('refuses missing / whitespace operator', () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: '   ',
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_operator' });
  });

  it('refuses omitted / blank / 0 / negative displayQty with missing_display_qty', () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_display_qty' });
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: '',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_display_qty' });
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: '0',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_display_qty' });
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: '-1',
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_display_qty' });
  });

  it("happy: status paper + displayQty '100' + operator + paper on", () => {
    const started = startPaperIcebergParent({
      parentClientOrderId: 'p-ice',
      status: 'paper',
      displayQty: DISPLAY,
      operatorId: OP,
      paper: PAPER_ON,
    });
    expect(started).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'paper',
      displayQty: formatAmount(parseAmount(DISPLAY)),
    });
    expect(started).not.toMatchObject({ status: 'running' });
  });

  it("happy: approved true + status paper + displayQty '100' + operator + paper on", () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'paper',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'paper',
      displayQty: formatAmount(parseAmount(DISPLAY)),
    });
  });

  it("happy: approved true + status approved + displayQty '100' + operator + paper on", () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        status: 'approved',
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'paper',
      displayQty: formatAmount(parseAmount(DISPLAY)),
    });
  });

  it("happy: approved true + displayQty '100' + operator + paper on (status omitted)", () => {
    expect(
      startPaperIcebergParent({
        parentClientOrderId: 'p-ice',
        approved: true,
        displayQty: DISPLAY,
        operatorId: OP,
        paper: PAPER_ON,
      }),
    ).toEqual({
      ok: true,
      started: true,
      paper: true,
      parentClientOrderId: 'p-ice',
      kind: 'iceberg',
      status: 'paper',
      displayQty: formatAmount(parseAmount(DISPLAY)),
    });
  });
});
