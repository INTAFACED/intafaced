// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OtcMakers, RfqBoard as Board } from '../rooms/api';
import { RfqBoard } from './RfqBoard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

// TEST providers and prices: fixtures, not an owner list or a live price.
const makers: OtcMakers = {
  published: true,
  makers: [
    { id: 'house', name: 'House desk (TEST)', route: 'platform' },
    { id: 'test-lp-1', name: 'TEST provider 1', route: 'outside' },
  ],
  selectCap: 3,
  emptyLabel: null,
};

const quote = (quoteId: string, makerId: string | null, quotedPrice: string, rank: number, test: boolean) => ({
  quoteId,
  makerId,
  rfqSeq: rank,
  quotedPrice,
  userNotional: quotedPrice,
  spreadBps: 10,
  lifecycle: 'open',
  test,
  rank,
  best: rank === 1,
  expiresAt: '2026-10-30T00:01:00.000Z',
});

const board: Board = {
  groups: [
    {
      status: 'open',
      count: 1,
      requests: [
        {
          rfqId: 'rfq-1',
          status: 'open',
          side: 'buy',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          qty: '1',
          createdAt: '2026-10-30T00:00:00.000Z',
          quotes: [quote('q-2', 'test-lp-1', '65065', 1, true), quote('q-1', 'house', '65130', 2, false)],
        },
      ],
    },
    { status: 'accepted', count: 0, requests: [] },
    { status: 'settled', count: 0, requests: [] },
    { status: 'expired', count: 0, requests: [] },
  ],
  more: false,
};

async function show(data: Board) {
  await act(async () =>
    root.render(<RfqBoard board={{ status: 'ready', data, asOf: 0 }} makers={{ status: 'ready', data: makers, asOf: 0 }} />),
  );
}
const region = () => host.querySelector('section[aria-label="Your requests"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the board of requests (CB-otc-02)', () => {
  it('shows every status group with the count the desk sent, in its order', async () => {
    await show(board);
    expect([...(region()?.querySelectorAll('h3') ?? [])].map((h) => h.textContent)).toEqual([
      'Open (1)',
      'Accepted (0)',
      'Settled (0)',
      'Expired (0)',
    ]);
  });

  it('keeps the desk ranking, marks only the first quote best and labels TEST quotes', async () => {
    await show(board);
    const rows = [...(region()?.querySelectorAll('[data-testid="board-quote"]') ?? [])];
    expect(rows.map((r) => r.getAttribute('data-quote-id'))).toEqual(['q-2', 'q-1']);
    expect(rows[0]?.textContent).toContain('TEST provider 1: 65,065');
    expect(rows[0]?.textContent).toContain('Best');
    expect(rows[0]?.textContent).toContain('TEST');
    expect(rows[1]?.textContent).toContain('House desk (TEST): 65,130');
    expect(rows[1]?.textContent).not.toContain('Best');
  });

  it('names a refusal instead of drawing an empty board', async () => {
    await act(async () =>
      root.render(
        <RfqBoard board={{ status: 'refused', code: 'trade.rfq_list_window_unset' }} makers={{ status: 'ready', data: makers, asOf: 0 }} />,
      ),
    );
    expect(region()?.querySelectorAll('h3')).toHaveLength(0);
    expect(region()?.textContent).toContain('trade.rfq_list_window_unset');
  });
});
