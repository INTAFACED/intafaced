import { describe, expect, it } from 'vitest';
import { STATEMENT_LOTS_MISSING } from './statement-pnl.js';
import { handleReportExport } from './report-export.js';

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

describe('CARD G-reporting NAV/SFTP/regulator export completeness', () => {
  it('refuses a complete NAV claim when ownerId is missing', () => {
    const out = handleReportExport({
      kind: 'nav',
      complete: true,
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('completeness_ids_missing');
    expect(out.complete).toBe(false);
    expect(out.missing).toEqual(['ownerId']);
    expect(out.included).toEqual(['reportingPeriod', 'lotIds']);
    expect(asJson(out)).not.toMatch(/"0"/);
  });

  it('refuses a complete SFTP claim when legalEntityId is missing', () => {
    const out = handleReportExport({
      kind: 'sftp',
      complete: true,
      ownerId: 'owner-1',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('completeness_ids_missing');
    expect(out.missing).toEqual(['legalEntityId']);
    expect(out.included).toContain('ownerId');
    expect(asJson(out)).not.toMatch(/"0"/);
  });

  it('refuses a complete regulator claim when regulatorId is missing', () => {
    const out = handleReportExport({
      kind: 'regulator',
      complete: true,
      ownerId: 'owner-1',
      legalEntityId: 'le-1',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('completeness_ids_missing');
    expect(out.missing).toEqual(['regulatorId']);
    expect(out.included).toEqual(['ownerId', 'legalEntityId', 'reportingPeriod', 'lotIds']);
  });

  it('keeps the B5 lots_missing refuse when complete and lot ids are absent', () => {
    const out = handleReportExport({
      kind: 'nav',
      complete: true,
      ownerId: 'owner-1',
      reportingPeriod: '2026-Q3',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe(STATEMENT_LOTS_MISSING);
    expect(out.missing).toEqual(['lotIds']);
    expect(asJson(out)).not.toMatch(/"0"/);
    expect(out).not.toHaveProperty('realized');
    expect(out).not.toHaveProperty('unrealized');
    expect(out).not.toHaveProperty('nav');
  });

  it('refuses invented FIFO / history / bare cost basis', () => {
    const fifo = handleReportExport({
      kind: 'nav',
      complete: true,
      ownerId: 'owner-1',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
      inventFifoFromHistory: true,
    });
    const history = handleReportExport({
      kind: 'sftp',
      complete: true,
      ownerId: 'owner-1',
      legalEntityId: 'le-1',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
      lotsFromHistory: true,
    });
    const bare = handleReportExport({
      kind: 'regulator',
      complete: true,
      ownerId: 'owner-1',
      legalEntityId: 'le-1',
      regulatorId: 'sec',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
      costBasis: '12.00',
    });
    expect(fifo.ok).toBe(false);
    expect(history.ok).toBe(false);
    expect(bare.ok).toBe(false);
    if (fifo.ok || history.ok || bare.ok) return;
    expect(fifo.reason).toBe('cost_basis_invented');
    expect(history.reason).toBe('cost_basis_invented');
    expect(bare.reason).toBe('cost_basis_invented');
    expect(asJson(bare)).not.toMatch(/12\.00/);
    expect(asJson(bare)).not.toMatch(/"0"/);
  });

  it('accepts a complete export only when required IDs and lot ids are present — no invented amounts', () => {
    const nav = handleReportExport({
      kind: 'nav',
      complete: true,
      ownerId: 'owner-1',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    });
    const sftp = handleReportExport({
      kind: 'sftp',
      complete: true,
      ownerId: 'owner-1',
      legalEntityId: 'le-1',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    });
    const regulator = handleReportExport({
      kind: 'regulator',
      complete: true,
      ownerId: 'owner-1',
      legalEntityId: 'le-1',
      regulatorId: 'sec',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    });
    expect(nav).toEqual({
      ok: true,
      kind: 'nav',
      complete: true,
      included: ['ownerId', 'reportingPeriod', 'lotIds'],
    });
    expect(sftp.ok).toBe(true);
    expect(regulator.ok).toBe(true);
    if (!regulator.ok) return;
    expect(regulator.included).toEqual(['ownerId', 'legalEntityId', 'regulatorId', 'reportingPeriod', 'lotIds']);
    expect(nav).not.toHaveProperty('realized');
    expect(nav).not.toHaveProperty('unrealized');
    expect(nav).not.toHaveProperty('amount');
    expect(asJson(nav)).not.toMatch(/"0"/);
  });

  it('lists included IDs on a partial NAV export and still invents no money', () => {
    const out = handleReportExport({
      kind: 'nav',
      ownerId: 'owner-1',
    });
    expect(out).toEqual({
      ok: true,
      kind: 'nav',
      complete: false,
      included: ['ownerId'],
    });
    expect(asJson(out)).not.toMatch(/"0"/);
  });

  it('refuses a regulator export missing owner, entity, regulator, period, or lots when complete is not exactly true', () => {
    const present = {
      ownerId: 'owner-1',
      legalEntityId: 'le-1',
      regulatorId: 'sec',
      reportingPeriod: '2026-Q3',
      lotIds: ['lot-1'],
    };

    const omitted = handleReportExport({ kind: 'regulator', ownerId: 'owner-1' });
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) {
      expect(omitted.reason).toBe('completeness_ids_missing');
      expect(omitted.complete).toBe(false);
      expect(omitted.missing).toEqual(['legalEntityId', 'regulatorId', 'reportingPeriod']);
      expect(omitted.included).toEqual(['ownerId']);
      expect(asJson(omitted)).not.toMatch(/"0"/);
    }

    for (const key of ['ownerId', 'legalEntityId', 'regulatorId', 'reportingPeriod', 'lotIds'] as const) {
      const body: Record<string, unknown> = { kind: 'regulator', complete: false, ...present };
      delete body[key];
      const out = handleReportExport(body);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.kind).toBe('regulator');
      expect(out.complete).toBe(false);
      expect(out.missing).toEqual([key]);
      expect(out.included).not.toContain(key);
      expect(out).not.toHaveProperty('costBasis');
      expect(out).not.toHaveProperty('amount');
      expect(asJson(out)).not.toMatch(/"0"/);
      if (key === 'lotIds') {
        expect(out.reason).toBe(STATEMENT_LOTS_MISSING);
      } else {
        expect(out.reason).toBe('completeness_ids_missing');
      }
    }

    const blanks = handleReportExport({
      kind: 'regulator',
      complete: false,
      ownerId: ' ',
      legalEntityId: '',
      regulatorId: 'sec',
      reportingPeriod: '2026-Q3',
      lotIds: [''],
    });
    expect(blanks.ok).toBe(false);
    if (!blanks.ok) {
      expect(blanks.reason).toBe('completeness_ids_missing');
      expect(blanks.missing).toEqual(['ownerId', 'legalEntityId']);
    }
  });
});
