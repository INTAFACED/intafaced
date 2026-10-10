import { describe, expect, it } from 'vitest';
import { describeDataLakeRetention, retentionPersistenceGate } from './retention-policy.js';

describe('describeDataLakeRetention', () => {
  it('reports capture-only when env unset', () => {
    expect(describeDataLakeRetention({})).toEqual({
      tsdbConfigured: false,
      retentionConfigured: false,
      canPersist: false,
      captureLogOnly: true,
    });
  });

  it('requires both tsdb and retention for canPersist', () => {
    expect(
      describeDataLakeRetention({
        CONNECT_DATA_LAKE_TSDB_URL: 'postgres://lake',
        CONNECT_DATA_LAKE_RETENTION_DAYS: '30',
      }),
    ).toEqual({
      tsdbConfigured: true,
      retentionConfigured: true,
      canPersist: true,
      captureLogOnly: false,
    });
  });

  it('does not claim persistence for a day string the purge gate refuses', () => {
    for (const days of ['0', '1.5', 'nope', '', '   ']) {
      expect(
        describeDataLakeRetention({
          CONNECT_DATA_LAKE_TSDB_URL: 'postgres://lake',
          CONNECT_DATA_LAKE_RETENTION_DAYS: days,
        }),
      ).toEqual({
        tsdbConfigured: true,
        retentionConfigured: false,
        canPersist: false,
        captureLogOnly: true,
      });
    }
  });
});

describe('retentionPersistenceGate', () => {
  it('refuses no_tsdb when url blank', () => {
    expect(retentionPersistenceGate({})).toEqual({ ok: false, reason: 'no_tsdb' });
  });

  it('refuses no_retention_policy when days unset or invalid', () => {
    expect(retentionPersistenceGate({ CONNECT_DATA_LAKE_TSDB_URL: 'postgres://lake' })).toEqual({
      ok: false,
      reason: 'no_retention_policy',
    });
    expect(
      retentionPersistenceGate({
        CONNECT_DATA_LAKE_TSDB_URL: 'postgres://lake',
        CONNECT_DATA_LAKE_RETENTION_DAYS: '0',
      }),
    ).toEqual({ ok: false, reason: 'no_retention_policy' });
  });

  it('opens when owner env is complete', () => {
    expect(
      retentionPersistenceGate({
        CONNECT_DATA_LAKE_TSDB_URL: 'postgres://lake',
        CONNECT_DATA_LAKE_RETENTION_DAYS: '90',
      }),
    ).toEqual({ ok: true, tsdbUrl: 'postgres://lake', retentionDays: 90 });
  });
});
