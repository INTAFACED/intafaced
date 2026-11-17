import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupportRoutingWaitingView } from '@/lib/support/types';
import { RoutingWaitingView } from './support-routing-waiting';

const T = '44444444-4444-4444-8444-444444444444';
const html = (view: SupportRoutingWaitingView | null, loading = false) =>
  renderToStaticMarkup(<RoutingWaitingView view={view} loading={loading} onRefresh={() => undefined} />);
const at = '2026-10-20T04:00:00.000Z';

describe('waiting for an agent', () => {
  it('lists each waiting request with svc-support’s code and plain words', () => {
    const out = html({ asOf: at, waiting: { kind: 'ok', data: [{ ticketId: T, code: 'support.no_agent_available', since: at }] } });
    expect(out).toContain('data-testid="routing-waiting"');
    expect(out).toContain(`data-testid="routing-waiting-${T}"`);
    expect(out).toContain('support.no_agent_available');
    expect(out).toContain('No agent available');
    expect(out).toContain(`href="/support/${T}"`);
  });
  it('none waiting is said only when svc-support says so', () => {
    expect(html({ asOf: at, waiting: { kind: 'ok', data: [] } })).toContain('data-testid="routing-waiting-none"');
  });
  it('a refused read is a refusal, never "none waiting"', () => {
    const out = html({ asOf: at, waiting: { kind: 'failed', forbidden: true, message: 'denied', code: null, notBuilt: false } });
    expect(out).toContain('Waiting for an agent unavailable');
    expect(out).not.toContain('routing-waiting-none');
  });
  it('a read that failed outright says so', () => {
    expect(html(null)).toContain('could not be read');
  });
});
