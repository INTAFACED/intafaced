import { renderToStaticMarkup } from 'react-dom/server';
import { encodeFunctionData, parseAbi } from 'viem';
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
import { BlockPage, BlocksList, TxPage, percentOf } from './pages';
import { ChainHome } from './ChainHome';

const ready = { status: 'ready' as const, chainId: 84532 };
const chainAnswer = { status: 'ready', data: { configuredChainId: 84532, reachable: true, observedChainId: 84532 } };
const block = (height: number, orphaned: { reason: string } | null = null) => ({
  chainId: 84532,
  height,
  hash: `0x${String(height).padStart(64, '0')}`,
  gasUsed: '15000000',
  gasLimit: '30000000',
  baseFeePerGas: '1000000007',
  utilisation: '0.5',
  miner: `0x${'1'.repeat(40)}`,
  size: 600,
  txCount: 2,
  timestamp: 1_790_000_000,
  orphaned,
});
const HASH = `0x${'cd'.repeat(32)}`;
const TO = `0x${'a'.repeat(40)}` as const;
const tx = (over: Record<string, unknown> = {}) => ({
  chainId: 84532,
  hash: HASH,
  status: 'success',
  replacingHash: null,
  transaction: {
    index: 0,
    from: `0x${'b'.repeat(40)}`,
    to: TO,
    value: '1500000000000000000',
    nonce: 3,
    gasLimit: '100000',
    gasPrice: '2000000000',
    input: encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount)']),
      functionName: 'approve',
      args: [TO, 7n],
    }),
  },
  receipt: { status: 'success', gasConsumed: '46000', revertReason: null, createdContract: null },
  logs: [{ logIndex: 0, address: TO, topics: [`0x${'e'.repeat(64)}`], data: '0x' }],
  orphaned: null,
  ...over,
});

describe('blocks list', () => {
  it('lists newest first, marks rows against the finalized height, badges a reorged block and reads the gas tracker', () => {
    answers['explorer:blocks-list:84532:head'] = {
      status: 'ready',
      data: {
        rows: [block(12), block(11, { reason: 'reorg' }), block(10)],
        nextCursor: 9,
        finalizedHeight: 10,
        asOf: '2026-10-29T05:00:00.000Z',
      },
    };
    const html = renderToStaticMarkup(<BlocksList chain={ready} />);
    expect(html).toContain('aria-label="Blocks"');
    expect(html).toMatch(/Finalized at block 10, as of \d{1,2}:\d{2}/);
    expect(html.indexOf('href="/chain/blocks/12"')).toBeLessThan(html.indexOf('href="/chain/blocks/10"'));
    expect(html).toContain('Reorged: reorg');
    expect(html).not.toContain('href="/chain/blocks/11"');
    // 12 is above the finalized height, 10 is at it; the reorged 11 is off the chain, never final.
    expect(html.match(/<td>(Finalized|Not finalized|Off the chain)<\/td>/g)).toEqual([
      '<td>Not finalized</td>',
      '<td>Off the chain</td>',
      '<td>Finalized</td>',
    ]);
    expect(html).toContain('aria-label="Gas tracker"');
    expect(html).toContain('1.000000007 gwei');
    // The reorged block is left out of the share: 30000000 of 60000000.
    expect(html).toContain('30000000 of 60000000 (50.00%)');
    expect(html).toContain('Older blocks');
  });
  it('says no block is final yet rather than inventing a height, and names the indexer when it cannot answer', () => {
    answers['explorer:blocks-list:84532:head'] = {
      status: 'ready',
      data: { rows: [block(1)], nextCursor: null, finalizedHeight: null, asOf: '2026-10-29T05:00:00.000Z' },
    };
    expect(renderToStaticMarkup(<BlocksList chain={ready} />)).toMatch(/No block is final yet, as of/);
    answers['explorer:blocks-list:84532:head'] = {
      status: 'failed',
      failure: { ok: false, reason: 'error', message: 'x', code: 'edge.upstream_unwired' },
    };
    const html = renderToStaticMarkup(<BlocksList chain={ready} />);
    expect(html).toContain('No blocks listed: the indexer service is not running here');
    expect(html).toContain('No blocks are listed, so there is no gas reading.');
  });
  it('computes the share exactly', () => {
    expect(percentOf(1n, 3n)).toBe('33.33');
    expect(percentOf(5n, 0n)).toBeNull();
  });
});

describe('latest transactions', () => {
  it('links each transaction by hash, newest first', () => {
    answers['explorer:txs:84532:latest'] = {
      status: 'ready',
      data: {
        rows: [
          {
            chainId: 84532,
            hash: HASH,
            blockHeight: 5,
            blockHash: '0x05',
            index: 0,
            from: TO,
            to: null,
            value: '0',
            status: 'failed',
            timestamp: 1,
            orphaned: null,
          },
        ],
        nextCursor: null,
        asOf: '2026-10-29T05:00:00.000Z',
      },
    };
    const html = renderToStaticMarkup(<ChainHome chain={ready} />);
    expect(html).toContain(`href="/chain/tx/${HASH}"`);
    expect(html).toContain('Reverted');
    expect(html).toContain('Contract created');
  });
});

describe('transaction page', () => {
  const key = `explorer:tx:84532:${HASH}`;
  it('shows the status, the decoded method with each argument named, and the logs tab', () => {
    answers['explorer:tx:chain'] = chainAnswer;
    answers[key] = { status: 'ready', data: tx() };
    const html = renderToStaticMarkup(<TxPage hash={HASH} />);
    expect(html).toMatch(/data-testid="tx-status"[^>]*>Success</);
    expect(html).toMatch(/data-testid="tx-input-method"[^>]*>approve</);
    expect(html).toMatch(/<dt>spender <span[^>]*>address<\/span><\/dt>/);
    expect(html).toMatch(/<dt>amount <span[^>]*>uint256<\/span><\/dt><dd><code>7<\/code>/);
    expect(html).toContain('1.5');
    expect(html).toContain('2 gwei');
    expect(html).toMatch(/role="tab"[^>]*>Logs</);
    expect(html).not.toContain('tx-revert-reason');
  });
  it('a reverted transaction shows its error, or "No reason returned" when there is none', () => {
    answers[key] = {
      status: 'ready',
      data: tx({
        status: 'failed',
        receipt: { status: 'failed', gasConsumed: '1', revertReason: 'InsufficientOutput()', createdContract: null },
      }),
    };
    expect(renderToStaticMarkup(<TxPage hash={HASH} />)).toMatch(/data-testid="tx-revert-reason"[^>]*>InsufficientOutput\(\)</);
    answers[key] = {
      status: 'ready',
      data: tx({ status: 'failed', receipt: { status: 'failed', gasConsumed: '1', revertReason: null, createdContract: null } }),
    };
    expect(renderToStaticMarkup(<TxPage hash={HASH} />)).toMatch(/data-testid="tx-revert-reason"[^>]*>No reason returned</);
    answers[key] = {
      status: 'ready',
      data: tx({
        status: 'failed',
        receipt: { status: 'failed', gasConsumed: '1', revertReason: 'indexer.trace_unavailable', createdContract: null },
      }),
    };
    expect(renderToStaticMarkup(<TxPage hash={HASH} />)).toMatch(
      /data-testid="tx-revert-reason"[^>]*>Reason not read: this network’s node did not trace the transaction</,
    );
  });
  it('an unknown method is not decoded and names its selector', () => {
    answers[key] = { status: 'ready', data: tx({ transaction: { ...tx().transaction, input: '0xdeadbeef' } }) };
    const html = renderToStaticMarkup(<TxPage hash={HASH} />);
    expect(html).toContain('Not decoded: no interface for method 0xdeadbeef');
    expect(html).not.toContain('tx-input-method');
  });
  it('a hash the indexer never saw reads "Not found on this network"', () => {
    answers[key] = { status: 'failed', failure: { ok: false, reason: 'error', message: 'Not found', code: 'NOT_FOUND' } };
    const html = renderToStaticMarkup(<TxPage hash={HASH} />);
    expect(html).toContain('Not found on this network');
    expect(html).toContain('data-code="protocol.not_found"');
  });
});

describe('block page', () => {
  it('a block that cannot be read names why and keeps its transactions table', () => {
    answers['explorer:block:chain'] = chainAnswer;
    answers['explorer:block:84532:123'] = {
      status: 'failed',
      failure: { ok: false, reason: 'error', message: 'indexer.chain_unreachable', code: 'indexer.chain_unreachable' },
    };
    const html = renderToStaticMarkup(<BlockPage height={123} />);
    expect(html).toContain('This block could not be read:');
    expect(html).toMatch(/<th[^>]*>Hash<\/th>/);
    expect(html).toContain('Its transactions are listed once the block can be read.');
  });
});
