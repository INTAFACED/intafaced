// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { DepositPendingView, DepositRecordsView } from './DepositRecords';
import type { DepositRecordView } from './deposit-reads';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
async function mount(node: React.ReactNode) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(node));
}

// TEST figures, not published settings.
const record = (over: Partial<DepositRecordView> = {}): DepositRecordView => ({
  id: 'd1',
  assetId: 'USDT',
  networkId: 'ethereum',
  address: '0xTEST1',
  txHash: '0xTESTTX1',
  outputIndex: 0,
  amount: '25',
  confirmations: 3,
  confirmationsRequired: 12,
  status: 'confirming',
  reason: null,
  minimumDeposit: '10',
  detectedAt: '2026-10-20T10:00:00.000Z',
  creditedAt: null,
  ...over,
});
const failed = (code: string) => ({ status: 'failed', failure: { ok: false, reason: 'error', message: 'x', code } }) as never;
const noop = () => undefined;

describe('pending deposits', () => {
  it('shows each row with its confirmation counter, and a blank target without inventing one', async () => {
    await mount(
      <DepositPendingView
        resource={{
          status: 'ready',
          data: {
            items: [
              { id: 'a', assetId: 'USDT', networkId: 'ethereum', amount: '25', confirmations: 3, confirmationsRequired: 12 },
              { id: 'b', assetId: 'BTC', networkId: 'bitcoin', amount: '0.5', confirmations: 1, confirmationsRequired: null },
            ],
          },
        }}
        reload={noop}
      />,
    );
    expect(host.textContent).toContain('3 of 12 confirmations');
    expect(host.textContent).toContain('1 confirmations so far');
    expect(host.textContent).not.toContain('of 0');
  });

  it('says nothing is on its way only when custody answered an empty list; custody off is named, not empty', async () => {
    await mount(<DepositPendingView resource={{ status: 'ready', data: { items: [] } }} reload={noop} />);
    expect(host.textContent).toContain('Nothing is on its way');
    act(() => root?.unmount());
    root = null;
    await mount(<DepositPendingView resource={failed('bank.deposit_custody_unset')} reload={noop} />);
    expect(host.textContent).toContain('crypto custody isn’t connected');
    expect(host.textContent).not.toContain('Nothing is on its way');
  });
});

describe('deposit records', () => {
  const view = (items: DepositRecordView[], total = items.length, filters = {}) => (
    <DepositRecordsView
      resource={{ status: 'ready', data: { items, total } }}
      reload={noop}
      filters={filters}
      onFilters={noop}
      assets={['USDT']}
      onMore={noop}
    />
  );

  it('shows status chips, the below-minimum reason with its figure, and a pending counter', async () => {
    await mount(
      view([
        record({ id: 'c', status: 'credited', confirmations: 12, creditedAt: '2026-10-20T10:20:00.000Z' }),
        record({ id: 'b', status: 'below_minimum', reason: 'below_minimum', amount: '9.5' }),
        record({ id: 'p' }),
        record({ id: 'w', reason: 'minimum_unset' }),
      ]),
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Credited');
    expect(text).toContain('Under the minimum of 10 USDT, so it was not credited.');
    expect(text).toContain('3 of 12 confirmations');
    expect(text).toContain('Waiting: this network has no minimum deposit set.');
  });

  it('says a reorg reversal and a reversal the balance could not cover in words', async () => {
    await mount(
      view([
        record({ id: 'r', status: 'reversed', reason: 'chain_reorg', creditedAt: '2026-10-20T10:20:00.000Z' }),
        record({ id: 'u', status: 'needs_review', reason: 'reversal_unfunded', creditedAt: '2026-10-20T10:20:00.000Z' }),
      ]),
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Reversed');
    expect(text).toContain(
      'The network rewrote the block this deposit was in, so it did not arrive. Anything credited from it was taken back once.',
    );
    expect(text).toContain('the funds are already spent, so support is reviewing it.');
  });

  it('offers more only while the total is larger than what is shown', async () => {
    await mount(view([record()], 3));
    expect(host.textContent).toContain('Showing 1 of 3');
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Load more')).toBe(true);
    act(() => root?.unmount());
    root = null;
    await mount(view([record()], 1));
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Load more')).toBe(false);
  });

  it('names an empty filter result and a custody that is off', async () => {
    await mount(view([]));
    expect(host.textContent).toContain('No deposit records match');
    act(() => root?.unmount());
    root = null;
    await mount(
      <DepositRecordsView
        resource={failed('bank.deposit_custody_unset')}
        reload={noop}
        filters={{}}
        onFilters={noop}
        assets={[]}
        onMore={noop}
      />,
    );
    expect(host.textContent).toContain('cannot be shown because crypto custody isn’t connected');
  });
});
