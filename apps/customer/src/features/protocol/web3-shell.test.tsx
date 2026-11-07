import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const answers: { chain: unknown; indexer?: unknown; keyed: Record<string, unknown> } = { chain: undefined, keyed: {} };
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = { query: () => new Promise(() => undefined), canWrite: () => true };
  return { ...real, useApi: () => api as never, useSession: () => ({ session: null, restoring: false }) as never };
});
vi.mock('../../shared/resource', () => ({
  // Only the chain status is answered; every other source stays loading, so the rooms show their own checking state.
  useResource: (_load: unknown, key: string) => ({
    resource:
      key.endsWith(':chain') && answers.chain
        ? answers.chain
        : key.endsWith(':indexer') && answers.indexer
          ? answers.indexer
          : (answers.keyed[key] ?? { status: 'loading' }),
    reload: () => undefined,
  }),
}));
import { Web3Shell } from '../../app/Web3Shell';
import { ProtocolRoutes } from './ProtocolRoutes';
import { PermitForm } from './wallet/PermitForm';

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
  it('names a blocked region in words and offers no signing action while the edge refuses it', () => {
    answers.chain = { status: 'failed', failure: { ok: false, reason: 'forbidden', message: 'x', code: 'edge.geo_blocked' } };
    const html = renderToStaticMarkup(
      <Web3Shell path="/wallet">
        <PermitForm />
      </Web3Shell>,
    );
    expect(html).toContain('data-notice="region"');
    expect(html).toContain('This service is not available in your region.');
    expect(html).toContain('no signing action is offered');
    expect(html).not.toContain('data-form="permit"');
    expect(html).not.toContain('Review and sign');
    answers.chain = chain(84532);
    const open = renderToStaticMarkup(
      <Web3Shell path="/wallet">
        <PermitForm />
      </Web3Shell>,
    );
    expect(open).not.toContain('data-notice="region"');
    expect(open).toContain('data-form="permit"');
  });
  it('lists the Swap blockers in order, chain unreachable first, and says a shared source line once', () => {
    answers.chain = {
      status: 'ready',
      data: { configuredChainId: 84532, reachable: false, observedChainId: null, refusalCode: 'protocol.chain_unreachable' },
    };
    answers.indexer = { status: 'failed', failure: { ok: false, reason: 'unreachable', message: 'x', code: 'edge.upstream_unavailable' } };
    const html = page('/dex');
    answers.indexer = undefined;
    const swap = /<li data-action="swap">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? '';
    expect(swap).toContain('rail.crypto');
    expect([...swap.matchAll(/<li[^>]*data-blocker="([a-z_]+)"/g)].map((match) => match[1])).toEqual([
      'chain_unreachable',
      'source_no_reply',
      'no_execution_path',
      'not_audited',
      'network_label',
    ]);
    expect(swap).not.toMatch(/INTACHAIN mainnet/i);
  });
  it('gives a block page its layout and names the indexer when it cannot be read, never a blank', () => {
    answers.chain = chain(84532);
    answers.keyed['explorer:block:84532:123456'] = {
      status: 'failed',
      failure: { ok: false, reason: 'error', message: 'Not connected', code: 'edge.upstream_unwired' },
    };
    const html = page('/chain/blocks/123456');
    expect(html).toContain('Block 123456');
    expect(html).toContain('data-blocker="indexer"');
    expect(html).toContain('This block could not be read: the indexer service is not running here');
    answers.keyed = {};
  });
  it('answers a block the indexer never saw "No such block on this network"', () => {
    answers.chain = chain(84532);
    answers.keyed['explorer:block:84532:123456'] = {
      status: 'failed',
      failure: { ok: false, reason: 'error', message: 'Not found', code: 'NOT_FOUND' },
    };
    const html = page('/chain/blocks/123456');
    expect(html).toContain('No such block on this network');
    expect(html).toContain('data-code="protocol.not_found"');
    expect(html).not.toContain('data-blocker');
    answers.keyed = {};
  });
  it('answers a malformed id protocol.not_found instead of looking anything up', () => {
    answers.chain = chain(84532);
    const html = page('/chain/tx/not-a-hash');
    expect(html).toContain('data-code="protocol.not_found"');
    expect(html).not.toContain('data-blocker');
  });
  it('keeps the wallet room visible with its connect panel, its six sections and the owner-decision QR path', () => {
    answers.chain = chain(84532);
    const html = page('/wallet');
    expect(html).toContain('Connect a wallet');
    expect(html).toContain('data-code="owner.decision"');
    for (const section of ['Overview', 'Activity', 'Approvals', 'Session keys', 'Accounts', 'Safety'])
      expect(html).toContain(`>${section}</button>`);
  });
  it('never renders an empty page for a path no route claims', () => {
    answers.chain = chain(84532);
    for (const path of ['/dex/unknown', '/dex/tokens/nope/deep', '/chain/foo', '/chain/tx', '/protocol/zzz', '/wallet/foo']) {
      const html = page(path);
      expect(html, path).toContain('data-code="protocol.not_found"');
      expect(html, path).toContain('<h1>');
    }
  });
});
