import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const answers: { chain: unknown } = { chain: undefined };
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query: () => new Promise(() => undefined), canWrite: () => true };
  return { ...real, useApi: () => api as never, useSession: () => ({ session: null, restoring: false }) as never };
});
vi.mock('../../shared/resource', () => ({
  // Only the chain status is answered; every other source stays loading, so the rooms show their own checking state.
  useResource: (_load: unknown, key: string) => ({
    resource: key.endsWith(':chain') && answers.chain ? answers.chain : { status: 'loading' },
    reload: () => undefined,
  }),
}));
import { Web3Shell } from '../../app/Web3Shell';
import { ProtocolRoutes } from './ProtocolRoutes';

const page = (path: string) =>
  renderToStaticMarkup(
    <Web3Shell path={path}>
      <ProtocolRoutes path={path} />
    </Web3Shell>,
  );
const chain = (configuredChainId: number) => ({
  status: 'ready' as const,
  data: { configuredChainId, reachable: true, observedChainId: configuredChainId },
});

describe('Web3 shell', () => {
  it('shows the testnet chip, the Not INTACHAIN pill, the wallet chip and the nav, and never says Parked', () => {
    answers.chain = chain(84532);
    const html = page('/dex');
    expect(html).toContain('Base Sepolia test network · Testnet only');
    expect(html).toContain('Not INTACHAIN · not audited');
    expect(html).toContain('No wallet connected');
    for (const item of ['Swap', 'Pools', 'Positions', 'Wallet', 'Explorer', 'Protocol']) expect(html).toContain(`>${item}</a>`);
    expect(html).not.toMatch(/parked/i);
    expect(html).not.toMatch(/INTACHAIN mainnet/i);
  });
  it('reads an unknown chain id as not confirmed, and waits honestly while checking', () => {
    answers.chain = chain(1);
    expect(page('/dex')).toContain('Unrecognised network · Not confirmed as INTACHAIN');
    answers.chain = undefined;
    expect(page('/dex')).toContain('Checking network…');
    answers.chain = { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x', code: 'edge.upstream_unavailable' } };
    expect(page('/dex')).toContain('Network unreachable · The Protocol service did not answer');
  });
  it('gives a detail route its full layout and names the indexer as the blocker, never a blank', () => {
    answers.chain = chain(84532);
    const html = page('/chain/blocks/123456');
    expect(html).toContain('data-blocker="indexer"');
    expect(html).toContain('Block 123456');
    expect(html).toContain('<th');
  });
  it('answers a malformed id protocol.not_found instead of looking anything up', () => {
    answers.chain = chain(84532);
    const html = page('/chain/tx/not-a-hash');
    expect(html).toContain('data-code="protocol.not_found"');
    expect(html).not.toContain('data-blocker');
  });
  it('keeps the wallet room visible and blocked by the wallet connection', () => {
    answers.chain = chain(84532);
    expect(page('/wallet')).toContain('data-blocker="wallet"');
  });
});
