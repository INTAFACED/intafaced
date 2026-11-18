import { describe, expect, it } from 'vitest';
import {
  NETWORK_SIGNAL_CONFIGURED_ENV,
  NETWORK_SIGNAL_FAIL_CLOSED_ENV,
  SANCTIONS_REGIONS_ENV,
  SANCTIONS_SOURCE_ENV,
} from '@intafaced/config';
import { ANALYTICS_ETL_WATERMARK_AT_ENV, ANALYTICS_REPLICA_URL_ENV } from '@intafaced/contracts';
import { EdgeComplianceQueue, edgeComplianceHonesty } from './compliance-honesty.js';

// This file proves the blank-list refusal. Since OWNER 258 (1) a dev or test process with no env list screens with
// the owner's unsigned rows (packages/config screening.ts), so the file keeps them out to stay on the blank list.
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

/**
 * Break on tip before this PR: /admin/status had kill honesty but no network
 * signal / freeze invent refuse / compliance queue partner refuse / analytics
 * dark surface — #1551 mechanisms lived only in packages/config with no door.
 *
 * Done bar: unset≠clear; invent freeze refuse; partner_cleared refuse without
 * screening partner; warehouse unconfigured/dark never paints live cubes.
 */

const cleanEnv = (): Record<string, string | undefined> => ({
  APP_ENV: 'test',
  // No sanctions list (the owner's unsigned rows kept out), no network partner, no analytics URLs.
  INTAFACED_UNSIGNED_SANCTIONS_ROWS: 'off',
});

describe('edge network signal honesty', () => {
  it('reports unset when no VPN partner is wired — never clear', () => {
    const h = edgeComplianceHonesty(cleanEnv());
    expect(h.network.signal.declaration).toBe('unset');
    expect(h.network.signal.partnerConfigured).toBe(false);
    expect(h.network.statusLine).toMatch(/network_signal=unset/);
    expect(h.network.access.allowed).toBe(true); // fail-closed default off
  });

  it('forged clear observation without partner stays unset', () => {
    const h = edgeComplianceHonesty(cleanEnv(), { networkObservation: { result: 'clear', source: 'forged' } });
    expect(h.network.signal.declaration).toBe('unset');
    expect(h.network.signal.partnerConfigured).toBe(false);
  });

  it('fail-closed refuses unset and dark', () => {
    const unset = edgeComplianceHonesty({
      ...cleanEnv(),
      [NETWORK_SIGNAL_FAIL_CLOSED_ENV]: '1',
    });
    expect(unset.network.access.allowed).toBe(false);
    expect(unset.network.access.code).toBe('denied.network_unconfigured');

    const dark = edgeComplianceHonesty(
      {
        ...cleanEnv(),
        [NETWORK_SIGNAL_CONFIGURED_ENV]: '1',
        [NETWORK_SIGNAL_FAIL_CLOSED_ENV]: '1',
      },
      { networkObservation: { result: 'error' } },
    );
    expect(dark.network.signal.declaration).toBe('dark');
    expect(dark.network.access.allowed).toBe(false);
    expect(dark.network.access.code).toBe('denied.network_dark');
  });
});

describe('edge freeze authority honesty', () => {
  it('names only ledger.posting as freeze authority', () => {
    const h = edgeComplianceHonesty(cleanEnv());
    expect(h.freeze.soleKey).toBe('ledger.posting');
    expect(h.freeze.authorities).toEqual(['ledger.posting']);
    expect(h.freeze.note).toMatch(/ledger\.posting/);
  });

  it('refuses invent freezes outside the ledger path', () => {
    const h = edgeComplianceHonesty(cleanEnv());
    expect(h.freeze.inventProbes['trade freeze'].ok).toBe(false);
    expect(h.freeze.inventProbes['pay freeze'].ok).toBe(false);
    expect(h.freeze.inventProbes['ledger.posting'].ok).toBe(true);
  });
});

describe('edge compliance queue residual', () => {
  it('empty queue is honest empty; partner_cleared refuses without screening partner', () => {
    const q = new EdgeComplianceQueue(() => cleanEnv());
    const snap = q.snapshot();
    expect(snap.empty).toBe(true);
    expect(snap.partnerConfigured).toBe(false);
    expect(snap.summary).toMatch(/EMPTY/);

    q.open({
      id: 'case-1',
      kind: 'screening_hit',
      subjectId: 'user-1',
      openedAt: '2026-08-09T00:00:00.000Z',
    });
    const refuse = q.dispose('case-1', { status: 'partner_cleared', partnerRef: 'slot-a' });
    expect(refuse.ok).toBe(false);
    if (!refuse.ok) expect(refuse.code).toBe('refuse.partner_absent');
    // Case remains open — failed dispose must not drop the hit.
    expect(q.snapshot().items).toHaveLength(1);
  });

  it('operator clear works without a partner; partner_cleared needs configured screening', () => {
    const bare = new EdgeComplianceQueue(() => cleanEnv());
    bare.open({
      id: 'case-op',
      kind: 'manual',
      subjectId: 'user-2',
      openedAt: '2026-08-09T00:00:00.000Z',
    });
    const cleared = bare.dispose('case-op', { status: 'cleared', by: 'operator', actor: 'ops-alice' });
    expect(cleared).toMatchObject({ ok: true, status: 'cleared', actor: 'ops-alice' });
    expect(bare.snapshot().empty).toBe(true);

    // `none` + source = reviewed-empty: partner slot configured without list content.
    const withList = new EdgeComplianceQueue(() => ({
      ...cleanEnv(),
      [SANCTIONS_REGIONS_ENV]: 'none',
      [SANCTIONS_SOURCE_ENV]: 'counsel-memo-test-2026-08-09',
    }));
    expect(withList.snapshot().partnerConfigured).toBe(true);
    withList.open({
      id: 'case-p',
      kind: 'screening_hit',
      subjectId: 'user-3',
      openedAt: '2026-08-09T00:00:00.000Z',
    });
    const r = withList.dispose('case-p', { status: 'partner_cleared', partnerRef: 'slot-b' });
    expect(r).toMatchObject({ ok: true, status: 'partner_cleared' });
  });
});

describe('edge analytics honesty residual', () => {
  it('unconfigured warehouse is unavailable — never live cubes', () => {
    const h = edgeComplianceHonesty(cleanEnv());
    expect(h.analytics.replicaConfigured).toBe(false);
    expect(h.analytics.surface.status).toBe('unavailable');
    expect(h.analytics.surface.mayLabelLive).toBe(false);
    expect(h.analytics.statusLine).toMatch(/unavailable|live=0/);
    expect(h.analytics.etlWatermark).toBe('absent');
    expect(h.analytics.etlNote).toMatch(/watermark/i);
  });

  it('writer-looking replica URL refuses — no fake pass', () => {
    const h = edgeComplianceHonesty({
      ...cleanEnv(),
      [ANALYTICS_REPLICA_URL_ENV.ledger]: 'postgres://svc_ledger:secret@localhost:5432/intafaced',
    });
    expect(h.analytics.refuse).toMatch(/ledger|writer|role/i);
    expect(h.analytics.surface.mayLabelLive).toBe(false);
    expect(h.analytics.statusLine).toMatch(/refuse|live=0/);
  });

  it('readonly replica without lag probe is dark unavailable — not live', () => {
    const h = edgeComplianceHonesty({
      ...cleanEnv(),
      [ANALYTICS_REPLICA_URL_ENV.ledger]: 'postgres://analytics_ro:x@localhost:5433/wh',
    });
    expect(h.analytics.replicaConfigured).toBe(true);
    expect(h.analytics.refuse).toBeNull();
    expect(h.analytics.surface.mayLabelLive).toBe(false);
    // No lag → unavailable lag_unknown, not ok with fake points.
    expect(h.analytics.surface.status).not.toBe('ok');
  });

  it('ETL watermark present does not paint live cubes (D26-P1-O4)', () => {
    const h = edgeComplianceHonesty({
      ...cleanEnv(),
      [ANALYTICS_REPLICA_URL_ENV.ledger]: 'postgres://analytics_ro:x@localhost:5433/wh',
      [ANALYTICS_ETL_WATERMARK_AT_ENV]: '2026-08-12T10:00:00.000Z',
    });
    expect(h.analytics.etlWatermark).toBe('present');
    expect(h.analytics.etlWatermarkAt).toBe('2026-08-12T10:00:00.000Z');
    expect(h.analytics.surface.mayLabelLive).toBe(false);
    expect(h.analytics.surface.status).not.toBe('ok');
  });

  it('junk ETL watermark env is absent — fail closed', () => {
    const h = edgeComplianceHonesty({
      ...cleanEnv(),
      [ANALYTICS_ETL_WATERMARK_AT_ENV]: 'not-a-timestamp',
    });
    expect(h.analytics.etlWatermark).toBe('absent');
    expect(h.analytics.etlWatermarkAt).toBeNull();
  });
});
