import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../session/session', async (original) => {
  const real = await original<typeof import('../../session/session')>();
  return { ...real, useApi: () => ({ query: () => new Promise(() => undefined) }) as never };
});
const answers: Record<string, unknown> = {};
vi.mock('../../../shared/resource', () => ({
  useResource: (_load: unknown, key: string) => ({ resource: answers[key] ?? { status: 'loading' }, reload: () => undefined }),
}));
import { ChainHome } from './ChainHome';

const ready84532 = { status: 'ready' as const, chainId: 84532 };
const row = (height: number, orphaned: { reason: string } | null = null) => ({
  chainId: 84532,
  height,
  hash: `0x${String(height).padStart(64, '0')}`,
  gasUsed: '21000',
  gasLimit: '30000000',
  utilisation: '0.0007',
  txCount: 1,
  timestamp: 1_790_000_000,
  orphaned,
});

describe('Chain home', () => {
  it('lists the indexer blocks newest first with a reorged one badged, and keeps INTACHAIN not launched', () => {
    answers['explorer:blocks:84532'] = {
      status: 'ready',
      data: { rows: [row(12), row(11, { reason: 'replaced by a heavier branch' })], nextCursor: null, asOf: '2026-10-29T05:00:00.000Z' },
    };
    const html = renderToStaticMarkup(<ChainHome chain={ready84532} />);
    expect(html).toContain('aria-label="Latest blocks"');
    expect(html.indexOf('>12<')).toBeLessThan(html.indexOf('>11<'));
    expect(html).toContain('Reorged: replaced by a heavier branch');
    expect(html).toMatch(/data-testid="chain-intachain"[^>]*>INTACHAIN: not launched\. Blocked: [^<]+Base Sepolia test network/);
    expect(html).not.toMatch(/INTACHAIN mainnet|INTACHAIN is live/i);
    expect(html).toContain('aria-label="Search by address, transaction or block"');
  });
  it('with no indexer behind the gateway, both tables keep their columns and say why they are empty', () => {
    answers['explorer:blocks:84532'] = {
      status: 'failed',
      failure: { ok: false, reason: 'error', message: 'Not connected', code: 'edge.upstream_unwired' },
    };
    const html = renderToStaticMarkup(<ChainHome chain={ready84532} />);
    expect(html).toContain('No blocks listed: the indexer service is not connected here');
    expect(html).toContain('aria-label="Latest transactions"');
    expect(html).toContain('The indexer has no list of recent transactions');
    expect(html).not.toMatch(/<td[^>]*>\s*0\s*<\/td>/);
  });
  it('with no confirmed network it lists no blocks and names no network on the INTACHAIN line', () => {
    const html = renderToStaticMarkup(
      <ChainHome chain={{ status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'down' }, reload: () => undefined }} />,
    );
    expect(html).toContain('could not be confirmed, so no blocks are listed');
    expect(html).toContain('INTACHAIN: not launched. Blocked:');
    expect(html).not.toContain('This explorer reads');
  });
});
