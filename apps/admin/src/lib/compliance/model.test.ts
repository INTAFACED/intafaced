import { describe, expect, it } from 'vitest';
import { dispositionGate, dispositionPhrase, readQueue, readStatus } from './model';

const queue = {
  items: [{ id: 'case-1', kind: 'screening_hit', subjectId: 'user-9', openedAt: '2026-10-17T02:00:00.000Z' }],
  partnerConfigured: false,
  empty: false,
  summary: 'compliance queue: 1 pending; partner=absent.',
  recentAudit: [{ at: '2026-10-17T02:00:00.000Z', itemId: 'case-1', ok: true, status: 'opened', actor: 'operator' }],
};
const status = {
  region: { code: 'XX', regionResolved: false, source: 'default', statusLine: 'region unresolved', note: 'n' },
  geoBlock: {
    allowed: false,
    code: 'refuse.screening_unset',
    reason: 'screening list is not configured',
    screeningDeclaration: 'unset',
    screeningConfigured: false,
    listHitCount: null,
    inventedBlockedList: false,
    regionResolved: false,
  },
  networkSignal: {
    declaration: 'unset',
    partnerConfigured: false,
    kind: 'none',
    statusLine: 'no partner',
    accessAllowed: false,
    accessCode: 'refuse.network_unset',
    summary: 'unknown',
  },
  freezeAuthority: { soleKey: 'ledger.posting', note: 'one key' },
  extra: 'ignored',
};

describe('queue reader', () => {
  it('reads exactly the edge’s snapshot', () => {
    expect(readQueue(queue)).toMatchObject({
      empty: false,
      items: [{ id: 'case-1', kind: 'screening_hit' }],
      recentAudit: [{ itemId: 'case-1' }],
    });
  });
  it('an empty queue is only empty when the edge says so and there are no items', () => {
    expect(readQueue({ ...queue, items: [], empty: true })).toMatchObject({ empty: true, items: [] });
    expect(readQueue({ ...queue, items: [], empty: false })).toBeNull();
    expect(readQueue({ ...queue, empty: true })).toBeNull();
  });
  it('refuses anything that is not exactly the shape: never an empty queue by default', () => {
    for (const bad of [
      null,
      [],
      {},
      { ...queue, items: 'x' },
      { ...queue, items: [{ id: 'a' }] },
      { ...queue, items: [{ ...queue.items[0], kind: 'wild' }] },
      { ...queue, partnerConfigured: 'no' },
      { ...queue, recentAudit: null },
    ]) {
      expect(readQueue(bad)).toBeNull();
    }
  });
});

describe('status reader', () => {
  it('reads the sections the page shows and drops the rest', () => {
    const read = readStatus(status);
    expect(read?.geoBlock).toMatchObject({ allowed: false, screeningConfigured: false, listHitCount: null });
    expect(read).not.toHaveProperty('extra');
  });
  it('an unknown or malformed section makes the whole read unusable rather than partly green', () => {
    for (const bad of [
      null,
      {},
      { ...status, geoBlock: { ...status.geoBlock, allowed: 'yes' } },
      { ...status, region: undefined },
      { ...status, networkSignal: null },
      { ...status, freezeAuthority: {} },
    ]) {
      expect(readStatus(bad)).toBeNull();
    }
  });
});

describe('the disposition form', () => {
  const ok = {
    status: 'cleared',
    itemId: 'case-1',
    reason: 'reviewed the screening hit, false positive',
    confirm: 'CLEAR case-1',
    busy: false,
  } as const;
  it('the phrase carries the case id and the direction', () => {
    expect(dispositionPhrase('cleared', 'case-1')).toBe('CLEAR case-1');
    expect(dispositionPhrase('rejected', 'case-1')).toBe('REJECT case-1');
  });
  it('opens only with a reason and the exact phrase for THIS case', () => {
    expect(dispositionGate(ok)).toEqual({ ok: true });
    expect(dispositionGate({ ...ok, confirm: 'CLEAR case-2' }).ok).toBe(false);
    expect(dispositionGate({ ...ok, confirm: 'REJECT case-1' }).ok).toBe(false);
    expect(dispositionGate({ ...ok, reason: 'short' }).ok).toBe(false);
    expect(dispositionGate({ ...ok, reason: 'x'.repeat(501) }).ok).toBe(false);
    expect(dispositionGate({ ...ok, busy: true }).ok).toBe(false);
  });
});
