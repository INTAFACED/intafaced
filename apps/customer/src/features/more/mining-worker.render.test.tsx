import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { WorkerDetailView } from './MiningWorkerDetail';
import type { WorkerOne, WorkerStateChanges } from './mining-reads';
import type { ApiResult } from '../../shared/api';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);
const noop = () => undefined;
const refused = (code: string): Extract<ApiResult<never>, { ok: false }> => ({
  ok: false,
  reason: 'error',
  message: code,
  code,
  status: 412,
});
const ready = <T,>(data: T) => ({ resource: { status: 'ready' as const, data }, reload: noop });

const ID = 'worker:11111111-1111-4111-8111-111111111111:Rig-Q';
const ONLINE: WorkerOne = {
  asOf: '2026-10-31T00:01:00.000Z',
  id: ID,
  name: 'Rig-Q',
  windowMinutes: 60,
  hashing: 'hashing',
  hashrate: '3',
  hashrateReason: null,
  connectivity: 'online',
  lastShareAt: '2026-10-31T00:00:30.000Z',
  state: 'active',
  quietSeconds: 60,
  alertLimitMode: null,
  alertLimit: null,
  alertLimitReason: 'mining.alert_limit_unset',
  maintenanceSince: null,
};
const NONE: WorkerStateChanges = { asOf: ONLINE.asOf, evaluatedAt: null, rows: [] };

describe('mining worker room', () => {
  it('shows hashing and connectivity as the pool answers them, with the last share and the quiet rule', () => {
    const out = html(<WorkerDetailView worker={ready(ONLINE)} changes={ready(NONE)} minutes={60} />);
    expect(out).toContain('data-testid="mining-worker-hashing" data-state="hashing"');
    expect(out).toContain('data-testid="mining-worker-connectivity" data-state="online"');
    expect(out).toContain('data-testid="mining-worker-last-share" data-at="2026-10-31T00:00:30.000Z"');
    expect(out).toContain('less than 60 seconds old');
    expect(out).toContain('No state change recorded yet');
    expect(out).toContain('The pool has no recorded check of this worker.');
  });

  it('an offline worker lists its one state change in the "State changes" table, and a blank alert limit says "not set" by its code', () => {
    const offline = {
      ...ONLINE,
      hashing: 'idle' as const,
      hashrate: null,
      hashrateReason: 'no_shares_in_window',
      connectivity: 'offline' as const,
      state: 'offline' as const,
    };
    const changes: WorkerStateChanges = {
      asOf: ONLINE.asOf,
      evaluatedAt: '2026-10-31T00:02:10.000Z',
      rows: [{ workerId: ID, from: 'online', to: 'offline', at: '2026-10-31T00:02:00.000Z' }],
    };
    const out = html(<WorkerDetailView worker={ready(offline)} changes={ready(changes)} minutes={60} />);
    expect(out).toContain('data-testid="mining-worker-connectivity" data-state="offline"');
    expect(out).toMatch(/role="region" aria-label="State changes"><table>/);
    expect(out.match(/<td>Online<\/td><td>Offline<\/td>/g)).toHaveLength(1);
    expect(out).toContain('<span data-testid="mining-worker-alert-limit" data-code="mining.alert_limit_unset">not set</span>');
    expect(out).toContain('Not chosen');
    expect(out).toContain('Save alert limit');
  });

  it('a set alert limit shows the pool value; maintenance says since when', () => {
    const out = html(
      <WorkerDetailView
        worker={ready({
          ...ONLINE,
          alertLimitMode: 'manual',
          alertLimit: '2.5',
          alertLimitReason: null,
          state: 'maintenance',
          maintenanceSince: '2026-10-31T00:00:00.000Z',
        })}
        changes={ready(NONE)}
        minutes={60}
      />,
    );
    expect(out).toMatch(/data-testid="mining-worker-alert-limit" data-mode="manual" class="numeric">2\.5</);
    expect(out).toContain('data-testid="mining-worker-state" data-state="maintenance"');
    expect(out).toContain('In maintenance since');
  });

  it('a refusal shows through the refusal catalogue, never as a raw code', () => {
    const out = html(
      <WorkerDetailView
        worker={{ resource: { status: 'failed', failure: refused('mining.quiet_interval_unset') }, reload: noop }}
        changes={{ resource: { status: 'failed', failure: refused('mining.worker_not_found') }, reload: noop }}
        minutes={60}
      />,
    );
    expect(out).toContain('data-testid="failure"');
    expect(out).not.toContain('mining-worker-connectivity');
    expect(out).not.toMatch(/>mining\.(quiet_interval_unset|worker_not_found)</);
  });
});
