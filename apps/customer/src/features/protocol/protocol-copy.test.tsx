import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store; read the stored preferences once.
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query: () => new Promise(() => undefined), canWrite: () => true };
  return { ...real, useApi: () => api as never };
});
import { blockersFor, type ProtocolSnapshot } from './blockers';
import { protocolCopy } from './copy';
import { Answer, ParkedProtocolRoom } from './ParkedProtocolRoom';
import type { ApiResult } from '../../shared/api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const t = protocolCopy.forLocale('en').t;
const failed = (failure: Partial<Refusal>) => ({
  resource: { status: 'failed' as const, failure: { ok: false as const, reason: 'error' as const, message: 'Refused', ...failure } },
  reload: () => undefined,
});
const render = (value: ReturnType<typeof failed>) =>
  renderToStaticMarkup(
    <Answer value={value as never} source={t('src_chain')} t={t}>
      {() => null}
    </Answer>,
  );

describe('Protocol rooms speak plainly', () => {
  it('names a source that did not answer by what it is, never by a procedure', () => {
    const down = { status: 'down' as const, reason: 'unreachable', message: 'The service could not be reached.' };
    const snapshot = { chain: down, audit: down, indexer: down, dex: down, health: down } as unknown as ProtocolSnapshot;
    const sources = new Set<string>();
    for (const action of ['swap', 'addLiquidity', 'smartAccount', 'stake'] as const)
      for (const found of blockersFor(action, snapshot)) if (found.code === 'source_down') sources.add(found.params.source!);
    expect([...sources].sort()).toEqual(['DEX status', 'network status', 'service health', 'indexer status'].sort());
  });

  it('shows "Could not load network status" and no dotted service name', () => {
    const html = render(failed({ reason: 'not_mounted' }));
    expect(html).toContain('Could not load network status');
    expect(html).not.toMatch(/protocol\.|indexer\.|dex\./);
  });

  it('offers Try again only when the service could not be reached', () => {
    expect(render(failed({ reason: 'unreachable', status: 503 }))).toContain('Retry');
    expect(render(failed({ reason: 'unreachable', message: 'The service could not be reached.' }))).toContain('Try again');
    expect(render(failed({ reason: 'error', code: 'protocol.chain_unset' }))).not.toMatch(/Try again|Retry/);
    expect(render(failed({ reason: 'not_mounted', status: 404 }))).not.toMatch(/Try again|Retry/);
  });

  it('says "Not INTACHAIN, not audited" once in the banner and does not repeat it above the page', () => {
    const html = renderToStaticMarkup(<ParkedProtocolRoom slug="chain" />);
    const eyebrow = /<[^>]*class="[^"]*eyebrow[^"]*"[^>]*>(.*?)<\/[a-z]+>/i.exec(html)?.[1] ?? '';
    expect(eyebrow).toBe(t('banner'));
    expect((html.match(/Not INTACHAIN/gi) ?? []).length).toBe(1);
    expect((html.match(/Not confirmed as INTACHAIN/gi) ?? []).length).toBe(0);
  });
});
