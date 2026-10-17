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
import { blockersFor, chainReasonWords, plainReason, type ProtocolSnapshot } from './blockers';
import { protocolCopy } from './copy';
import { Answer, NoAnswerNote, ParkedProtocolRoom } from './ParkedProtocolRoom';
import type { ApiResult } from '../../shared/api';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
const t = protocolCopy.forLocale('en').t;
const down = { status: 'down' as const, reason: 'unreachable', message: 'x' };
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
      for (const found of blockersFor(action, snapshot)) if (found.code === 'source_no_reply') sources.add(found.params.source!);
    expect([...sources].sort()).toEqual(['DEX status', 'network status', 'service health', 'indexer status'].sort());
  });

  it('shows "Could not load network status" and no dotted service name', () => {
    const html = render(failed({ reason: 'not_mounted' }));
    expect(html).toContain('Could not load network status');
    expect(html).not.toMatch(/protocol\.|indexer\.|dex\./);
  });

  it('offers Try again only when the service could not be reached', () => {
    expect(render(failed({ reason: 'unreachable', status: 503, code: 'edge.upstream_unwired' }))).not.toMatch(/Try again|Retry/);
    expect(render(failed({ reason: 'unreachable', status: 503, code: 'edge.upstream_unwired' }))).toContain(
      'The Protocol service is not connected here',
    );
    // A 502 or 504 is a crash, a restart or a timeout: a second attempt can help, so Retry stays.
    expect(render(failed({ reason: 'unreachable', status: 502, code: 'edge.upstream_unavailable' }))).toMatch(/Try again|Retry/);
    // ...and it says so honestly: the service did not answer, not "can't connect" and not "not connected".
    const crashed = render(failed({ reason: 'unreachable', status: 502, code: 'edge.upstream_unavailable' }));
    expect(crashed).toContain('The Protocol service didn’t answer.');
    expect(crashed).not.toMatch(/not connected|Can’t connect/);
    expect(render(failed({ reason: 'unreachable', status: 504 }))).toMatch(/Try again|Retry/);
    expect(render(failed({ reason: 'unreachable', message: 'The service could not be reached.' }))).toContain('Try again');
    expect(render(failed({ reason: 'error', code: 'protocol.chain_unset' }))).not.toMatch(/Try again|Retry/);
    expect(render(failed({ reason: 'not_mounted', status: 404 }))).not.toMatch(/Try again|Retry/);
  });

  it('keeps Try again inside the retry window and drops it once the service has stayed silent', () => {
    const open = renderToStaticMarkup(<NoAnswerNote service="Protocol" closed={false} reload={() => undefined} t={t} />);
    expect(open).toContain('The Protocol service didn’t answer.');
    expect(open).toMatch(/Try again/);
    const closed = renderToStaticMarkup(<NoAnswerNote service="Protocol" closed reload={() => undefined} t={t} />);
    expect(closed).toContain('The Protocol service isn’t running here.');
    expect(closed).not.toMatch(/Try again|Retry/);
    expect(closed).not.toMatch(/edge\.|upstream|502/);
  });

  it('says "Not INTACHAIN, not audited" once in the banner and does not repeat it above the page', () => {
    const html = renderToStaticMarkup(<ParkedProtocolRoom slug="chain" />);
    const eyebrow = /<p[^>]*class="[^"]*eyebrow[^"]*"[^>]*>(.*?)<\/p>/i.exec(html)?.[1] ?? '';
    expect(eyebrow).toContain(`<span>${t('bannerLine')}</span>`);
    expect(eyebrow).toContain(`<span class="badge protocol-pill">${t('bannerPill')}</span>`);
    expect((html.match(/Not INTACHAIN/gi) ?? []).length).toBe(1);
    expect((html.match(/Not confirmed as INTACHAIN/gi) ?? []).length).toBe(0);
  });

  it('keeps the table headers and says why the table is empty when the service is not connected here', () => {
    const html = renderToStaticMarkup(
      <Answer
        value={failed({ reason: 'unreachable', status: 503, code: 'edge.upstream_unwired' }) as never}
        source={t('src_chain')}
        t={t}
        shell={{ label: 'Status', headers: [t('hdr_check'), t('hdr_result')] }}
      >
        {() => null}
      </Answer>,
    );
    expect(html).toContain('<th scope="col">Check</th>');
    expect(html).toContain('<th scope="col">Result</th>');
    expect(html).toContain('The Protocol service is not connected here, so there is nothing to show.');
    expect(html).not.toMatch(/Try again|Retry/);
  });

  it('never doubles punctuation or prints an HTTP code when a reason is dropped into a sentence', () => {
    expect(plainReason('The service refused this request (502).')).toBe('The service refused this request');
    expect(plainReason('Node is down...')).toBe('Node is down');
    const down = { status: 'down' as const, reason: 'error', message: 'The service refused this request (502).' };
    const snapshot = { chain: down, audit: down, indexer: down, dex: down, health: down } as unknown as ProtocolSnapshot;
    const found = blockersFor('swap', snapshot)[0]!;
    const sentence = t(found.key, found.params);
    expect(sentence).toBe('Cannot confirm: network status did not answer (the service refused this request).');
    expect(sentence).not.toMatch(/502|\.\)\./);
  });

  it('says the service is not connected here only for the gateway\'s own "not connected" answer', () => {
    const unwired = { status: 'down' as const, reason: 'unreachable', message: 'x', code: 'edge.upstream_unwired' };
    const snapshot = { chain: unwired, audit: unwired, indexer: unwired, dex: unwired, health: unwired } as unknown as ProtocolSnapshot;
    const found = blockersFor('swap', snapshot)[0]!;
    expect(t(found.key, found.params)).toBe('The Protocol service is not connected here.');
    const dexSnapshot = {
      ...snapshot,
      chain: { status: 'ok', data: { reachable: true, configuredChainId: 84532, observedChainId: 84532 } },
    };
    const dexFound = blockersFor('addLiquidity', dexSnapshot as unknown as ProtocolSnapshot).find(
      (entry) => entry.code === 'source_not_connected',
    )!;
    expect(dexFound.params.service).toBe('DEX');
    // A 502 that carries another code is a plain "did not answer", never "not connected".
    const crashed = {
      status: 'down' as const,
      reason: 'unreachable',
      message: 'The service could not be reached.',
      code: 'edge.upstream_unavailable',
    };
    const crashedSnapshot = { ...snapshot, chain: crashed } as unknown as ProtocolSnapshot;
    expect(blockersFor('swap', crashedSnapshot)[0]!.code).toBe('source_no_reply');
  });

  it('never prints the chain status reason: no address, no spec text', () => {
    const chain = {
      reachable: false,
      configuredChainId: 84532,
      observedChainId: null,
      blockNumber: null,
      suiteConfigured: true,
      suiteDeployed: false,
      tokenFactoryConfigured: true,
      tokenFactoryDeployed: false,
      refusalCode: 'protocol.chain_unreachable',
      reason: 'status: no answer from the EVM RPC at https://rpc.example/key123 No chain state was read (SOCKET §13 socket.evm-rpc)',
      usable: false,
      launchUsable: false,
    };
    const value = { resource: { status: 'ready' as const, data: chain }, reload: () => undefined };
    const html = renderToStaticMarkup(
      <Answer value={value as never} source={t('src_chain')} t={t}>
        {(c: typeof chain) => <p>{chainReasonWords(c.refusalCode)}</p>}
      </Answer>,
    );
    expect(html).toContain('The network did not answer.');
    expect(html).not.toMatch(/https?:|SOCKET|rpc\.example|key123/i);
    const snapshot = {
      chain: { status: 'ok', data: chain },
      audit: down,
      indexer: down,
      dex: down,
      health: down,
    } as unknown as ProtocolSnapshot;
    const found = blockersFor('swap', snapshot)[0]!;
    expect(t(found.key, found.params)).toBe('The chain is unreachable. The network did not answer.');
    expect(chainReasonWords('protocol.contract_not_deployed')).toBe('The contracts are not on this network.');
    expect(chainReasonWords(null)).toBe('The network gave no usable answer.');
  });
});
