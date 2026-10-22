import { MODULE_IDS } from '@intafaced/config';
import { describe, expect, it } from 'vitest';
import { readData } from '@/lib/ops-desk/model';
import type { ReadOutcome, ReadSpec } from '@/lib/ops-desk/types';
import { HEALTH_ROWS, boardReads, buildBoard } from './board';

const AT = '2026-10-22T23:30:00.000Z';
const specOf = (id: string): ReadSpec => boardReads().find((r) => r.id === id)!;
const ok = (id: string, raw: unknown): ReadOutcome => {
  const data = readData(specOf(id), raw);
  if (!data) throw new Error(`fixture for ${id} does not read`);
  return { id, asOf: AT, part: { kind: 'ok', data } };
};
const failed = (id: string): ReadOutcome => ({
  id,
  asOf: AT,
  part: { kind: 'failed', message: 'svc-p2p did not accept your founder session.', code: 'denied', notBuilt: false, forbidden: true },
});

const STANDING = { total: 10, settled: 7, pending: 1, rejected: 2, skipped: 0, failureRate: '0.2', oldestPendingAgeSeconds: 300 };
const transfer = (over: Record<string, unknown> = {}) => ({
  asOf: AT,
  standingOrders: STANDING,
  oneOff: {
    available: true,
    total: 5,
    posted: 4,
    reserved: 1,
    failureRate: null,
    failureRateReason: 'failures_not_recorded',
    oldestPendingAgeSeconds: 4000,
  },
  bills: {
    available: true,
    total: 3,
    paid: 1,
    accepted: 0,
    submitted: 0,
    failed: 1,
    returned: 1,
    failureRate: '0.66',
    oldestPendingAgeSeconds: null,
  },
  ...over,
});
const P2P_COUNTS = {
  offers: { active: 1, paused: 0, closed: 0 },
  trades: { created: 1, escrowed: 2, fiat_sent: 0, released: 5, cancelled: 1, disputed: 1 },
};
const BACKLOG = { open: 3, overdue: 1, escalated: 0, neverSeen: 0, moderationConfigured: true };

describe('module health board', () => {
  it('has exactly one row per platform module, in the platform order', () => {
    expect(HEALTH_ROWS.map((r) => r.module)).toEqual([...MODULE_IDS]);
  });

  it('a module with no source shows its blocker and no count', () => {
    const row = buildBoard({}).find((r) => r.module === 'academy')!;
    expect(row.state).toBe('unwired');
    expect(row).not.toHaveProperty('volume');
  });

  it('bank: volume, failures and oldest from svc-bank transfer health, summed as whole numbers', () => {
    const outcomes = Object.fromEntries(['pay.standing-24h', 'pay.oneoff-24h', 'pay.bills-24h'].map((id) => [id, ok(id, transfer())]));
    const row = buildBoard(outcomes).find((r) => r.module === 'bank')!;
    expect(row).toMatchObject({ state: 'read', volume: { value: '18' }, failures: { value: '4' } });
    if (row.state !== 'read') throw new Error('not read');
    expect(row.oldest.value).toMatch(/1 h/);
  });

  it('one module’s failed read refuses only its own row', () => {
    const outcomes: Record<string, ReadOutcome> = {
      'p2p.counts': failed('p2p.counts'),
      'p2p.backlog': ok('p2p.backlog', BACKLOG),
      ...Object.fromEntries(['pay.standing-24h', 'pay.oneoff-24h', 'pay.bills-24h'].map((id) => [id, ok(id, transfer())])),
    };
    const rows = buildBoard(outcomes);
    expect(rows.find((r) => r.module === 'p2p')).toMatchObject({ state: 'refused', service: 'svc-p2p' });
    expect(rows.find((r) => r.module === 'bank')).toMatchObject({ state: 'read' });
  });

  it('p2p: trades all time, disputes as failures, and no invented age for the oldest dispute', () => {
    const row = buildBoard({ 'p2p.counts': ok('p2p.counts', P2P_COUNTS), 'p2p.backlog': ok('p2p.backlog', BACKLOG) }).find(
      (r) => r.module === 'p2p',
    )!;
    expect(row).toMatchObject({ state: 'read', volume: { value: '10' }, failures: { value: '1' }, oldest: { value: null } });
    if (row.state === 'read') expect(row.oldest.note).toContain('3 open now, 1 overdue');
  });

  it('a total with a part the service did not give is "not given", never a partial number shown as complete', () => {
    const counts = { ...P2P_COUNTS, trades: { ...P2P_COUNTS.trades, fiat_sent: 'n/a' } };
    const data = readData(specOf('p2p.counts'), counts);
    // The read itself refuses a wrong-typed count, so the whole row refuses rather than sum five of six.
    expect(data).toBeNull();
    const outcomes = Object.fromEntries(
      ['pay.standing-24h', 'pay.oneoff-24h', 'pay.bills-24h'].map((id) => [
        id,
        id === 'pay.oneoff-24h'
          ? { ...ok(id, transfer()), part: { kind: 'ok' as const, data: { shape: 'record' as const, cells: [] } } }
          : ok(id, transfer()),
      ]),
    );
    const row = buildBoard(outcomes).find((r) => r.module === 'bank')!;
    expect(row).toMatchObject({ state: 'read', volume: { value: null }, failures: { value: '4' } });
  });

  it('a read that was not made refuses the row rather than show a guess', () => {
    expect(buildBoard({}).find((r) => r.module === 'mining-pool')).toMatchObject({ state: 'refused' });
  });

  it('boardReads lists each read once', () => {
    const ids = boardReads().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
