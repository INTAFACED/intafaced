import { describe, expect, it } from 'vitest';
import { InstrumentError } from './instruments.js';
import { InstrumentService, assertPurgeExpiredSnapshotsLimit } from './instrument-service.js';
import { limitsOf, recordingSql } from './testing/sql-recorder-fixture.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';

/**
 * purgeExpiredSnapshots batch size is refuse-closed when unset.
 *
 * purgeExpiredSnapshots used `limit = 500`, so omit invented a 500-row purge batch.
 * Blank must refuse. Owner may pass 500 explicitly.
 */

describe('purgeExpiredSnapshots limit unset refuse', () => {
  it('assertPurgeExpiredSnapshotsLimit refuses blank / NaN / 0 — never invents 500', () => {
    expect(() => assertPurgeExpiredSnapshotsLimit(undefined)).toThrow(InstrumentError);
    expect(() => assertPurgeExpiredSnapshotsLimit(Number.NaN)).toThrow(InstrumentError);
    expect(() => assertPurgeExpiredSnapshotsLimit(0)).toThrow(InstrumentError);
    try {
      assertPurgeExpiredSnapshotsLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(InstrumentError);
      expect((e as InstrumentError).code).toBe('p2p.purge_snapshots_limit_unset');
      expect((e as InstrumentError).message).toBe(resolveP2pCopy(P2P_COPY.purgeSnapshotsLimitUnset));
      expect((e as InstrumentError).message).not.toMatch(/500-row|default 500/i);
    }
  });

  it('purgeExpiredSnapshots refuses without limit — never invents 500', async () => {
    const instruments = new InstrumentService({} as never, { retentionDays: 90 });
    await expect(instruments.purgeExpiredSnapshots()).rejects.toMatchObject({
      code: 'p2p.purge_snapshots_limit_unset',
    });
    expect(assertPurgeExpiredSnapshotsLimit(500)).toBe(500);
  });

  it('accepts owner-published 500 and caps at 5000', () => {
    expect(assertPurgeExpiredSnapshotsLimit(500)).toBe(500);
    expect(assertPurgeExpiredSnapshotsLimit(1)).toBe(1);
    expect(assertPurgeExpiredSnapshotsLimit(5_000)).toBe(5_000);
    expect(assertPurgeExpiredSnapshotsLimit(5_001)).toBe(5_000);
  });

  it('purgeExpiredSnapshots purges by the batch it was given, capped at 5000, and touches nothing without one', async () => {
    const { sql, calls } = recordingSql();
    const instruments = new InstrumentService(sql, { retentionDays: 90 });
    await expect(instruments.purgeExpiredSnapshots()).rejects.toMatchObject({ code: 'p2p.purge_snapshots_limit_unset' });
    expect(calls).toHaveLength(0);
    await expect(instruments.purgeExpiredSnapshots(500)).resolves.toEqual({ purged: 0 });
    await instruments.purgeExpiredSnapshots(5_001);
    expect(limitsOf(calls)).toEqual([500, 5_000]);
  });
});
