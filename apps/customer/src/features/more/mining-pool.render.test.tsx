import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../session/session';
import { MiningPoolStatus, PoolConnectView, PoolOverviewView, PoolProbeView, workerNameFor } from './MiningPool';
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

describe('pool overview', () => {
  it('a wholly unpublished overview shows each section "Not set" and no text of its own', () => {
    const out = html(
      <PoolOverviewView read={{ resource: { status: 'failed', failure: refused('mining.overview_unset') }, reload: noop }} />,
    );
    for (const section of ['Coin', 'Hardware', 'Revenue split', 'Not supported']) {
      expect(out).toContain(`aria-label="${section}" data-state="unset"`);
    }
    expect(out.match(/Not set/g)).toHaveLength(4);
    expect(out).not.toContain('Published overview');
  });

  it('a blank section among published ones is "Not set"; the others show the owner text as stored', () => {
    const data = { version: 'TEST-1', what: null, coin: 'TEST coin', hardware: null, revenueSplit: 'TEST split', notSupported: null };
    const out = html(<PoolOverviewView read={{ resource: { status: 'ready', data }, reload: noop }} />);
    expect(out).toContain('aria-label="Coin" data-state="set"');
    expect(out).toContain('TEST coin');
    expect(out).toContain('aria-label="Hardware" data-state="unset"');
    expect(out).toContain('TEST split');
  });
});

describe('connect your miner', () => {
  it('a blank host shows the typed refusal and nothing to copy', () => {
    const out = html(
      <PoolConnectView read={{ resource: { status: 'failed', failure: refused('mining.connection_unset') }, reload: noop }} />,
    );
    expect(out).toContain('data-testid="mining-connection-unset"');
    expect(out).toContain('The pool address is not published');
    expect(out).not.toContain('Copy pool address');
  });

  it('shows host:port, the account id and the worker name exactly as stored', () => {
    const data = {
      host: '127.0.0.1',
      port: '3999',
      secureUrl: null,
      accountId: 'acct-1',
      workerNamePattern: 'TEST.{worker}',
      credentialOffered: false as const,
      credentialReason: 'mining.credential_not_issued',
    };
    const out = html(<PoolConnectView read={{ resource: { status: 'ready', data }, reload: noop }} />);
    expect(out).toContain('data-testid="mining-pool-address" lang="und" dir="ltr">127.0.0.1:3999<');
    expect(out).toContain('data-testid="mining-account-id" lang="und" dir="ltr">acct-1<');
    // No rig typed yet: the worker name is not made up from the bare pattern, and its copy button is off.
    expect(out).toContain('data-testid="mining-worker-name" lang="und" dir="ltr">Type your rig name');
    expect(out).not.toContain('{worker}');
    expect(out).toMatch(/aria-label="Copy worker name" disabled/);
    expect(out).not.toContain('mining-secure-address');
  });

  it('a published secure address is shown to copy as stored', () => {
    const data = {
      host: 'h',
      port: '1',
      secureUrl: 'stratum+ssl://TEST:4000',
      accountId: 'a',
      workerNamePattern: null,
      credentialOffered: false as const,
      credentialReason: 'x',
    };
    const out = html(<PoolConnectView read={{ resource: { status: 'ready', data }, reload: noop }} />);
    expect(out).toContain('data-testid="mining-secure-address" lang="und" dir="ltr">stratum+ssl://TEST:4000<');
    expect(out).toContain('data-testid="mining-worker-name" lang="und" dir="ltr">Not set<');
  });

  it('fills the published worker pattern with the rig name, and invents none without a pattern', () => {
    expect(workerNameFor('TEST.{worker}', 'Rig-A')).toBe('TEST.Rig-A');
    expect(workerNameFor(null, 'Rig-A')).toBeNull();
    expect(workerNameFor('TEST.{worker}', '')).toBeNull();
    expect(workerNameFor('TEST.fixed', '')).toBe('TEST.fixed');
  });
});

describe('reachability test', () => {
  const probe = (result: 'reachable' | 'refused' | 'timed_out') => ({ result, roundTripMs: '1000', viewpoint: 'pool_network' as const });

  it('a timed-out press says "Timed out" with its label, never a success', () => {
    const out = html(<PoolProbeView state={{ status: 'done', probe: probe('timed_out') }} onPress={noop} />);
    expect(out).toContain('data-result="timed_out"');
    expect(out).toContain('Timed out after 1000 ms');
    expect(out).toContain('Tested from the pool’s own network');
    expect(out).not.toContain('Reached in');
  });

  it('a refused press says not reached', () => {
    const out = html(<PoolProbeView state={{ status: 'done', probe: probe('refused') }} onPress={noop} />);
    expect(out).toContain('Not reached');
    expect(out).not.toContain('Reached in');
  });

  it('past the owner limit the typed limit refusal shows as an alert, and the last result stays', () => {
    const out = html(
      <PoolProbeView
        state={{ status: 'failed', failure: refused('mining.probe_limit_reached'), last: probe('timed_out') }}
        onPress={noop}
      />,
    );
    expect(out).toContain('role="alert" data-code="mining.probe_limit_reached"');
    expect(out).toContain('too many connection tests');
    expect(out).toContain('Timed out after 1000 ms');
  });

  it('a blank limit or wait refuses by name', () => {
    expect(
      html(<PoolProbeView state={{ status: 'failed', failure: refused('mining.probe_limit_unset'), last: null }} onPress={noop} />),
    ).toContain('no published limit');
    expect(
      html(<PoolProbeView state={{ status: 'failed', failure: refused('mining.probe_timeout_unset'), last: null }} onPress={noop} />),
    ).toContain('no published wait');
    expect(
      html(<PoolProbeView state={{ status: 'failed', failure: refused('mining.connection_unset'), last: null }} onPress={noop} />),
    ).toContain('role="alert" data-code="mining.connection_unset"');
  });

  it('a code that is not a known refusal is a plain failure, never a copy lookup', () => {
    const out = html(<PoolProbeView state={{ status: 'failed', failure: refused('constructor'), last: null }} onPress={noop} />);
    expect(out).not.toContain('data-code="constructor"');
  });
});

describe('pool status', () => {
  it('says answering only when the pool replied, and not answering when it did not', () => {
    const health = {
      ok: true as const,
      service: 'svc-mining-pool' as const,
      ledger: { status: 'configured' as const, code: 'x' },
      pg: { status: 'configured' as const, code: 'x' },
      jobs: [],
    };
    expect(
      html(
        <MiningPoolStatus
          probe={{ state: { status: 'idle' }, press: noop }}
          health={{ resource: { status: 'ready', data: health }, reload: noop }}
        />,
      ),
    ).toContain('data-state="answering">Answering');
    expect(
      html(
        <MiningPoolStatus
          probe={{ state: { status: 'idle' }, press: noop }}
          health={{ resource: { status: 'failed', failure: refused('x') }, reload: noop }}
        />,
      ),
    ).toContain('data-state="silent">Not answering');
  });
});
