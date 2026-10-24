// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space } from './client';
import type { sorterListSchema, sorterRunSchema } from './contracts';
import type { z } from 'zod';

/**
 * The income sorter card (BK-pots-03, J-bank-07 #4): every target space is named by the bank, an archived one too. An
 * archived one says its share stays in the account, and that share counts toward what stays. The page's own space list
 * holds only live spaces.
 */

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
let list: z.infer<typeof sorterListSchema>;
let runs: z.infer<typeof sorterRunSchema>[] = [];
vi.mock('./components', async (original) => {
  const real = await original<typeof import('./components')>();
  return {
    ...real,
    useBankRead: (procedure: string) => ({
      resource: { status: 'ready', data: procedure === 'sorter.list' ? list : runs },
      reload: () => undefined,
    }),
  };
});
import { IncomeSorter } from './IncomeSorter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const BILLS = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
let host: HTMLDivElement;
let root: Root | null = null;

const live = { id: BILLS, name: 'Bills TEST', assetId: 'USDT', kind: 'named' } as unknown as Space;

beforeEach(() => {
  list = {
    terms: { state: 'set', minCredit: '1' },
    sorters: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        assetId: 'USDT',
        status: 'active',
        legs: [
          { spaceId: BILLS, shareBp: 6000, spaceName: 'Bills TEST', archived: false },
          { spaceId: GONE, shareBp: 4000, spaceName: 'Rainy day TEST', archived: true },
        ],
        createdAt: '2026-10-24T10:00:00.000Z',
        cancelledAt: null,
      },
    ],
  };
  runs = [
    {
      id: '44444444-4444-4444-8444-444444444444',
      creditTransferId: 'pay-1',
      creditTxId: 'tx-1',
      creditAmount: '100',
      creditPostedAt: '2026-10-24T11:00:00.000Z',
      skippedReason: null,
      createdAt: '2026-10-24T11:00:00.000Z',
      legs: [
        { position: 0, spaceId: BILLS, amount: '60', status: 'settled', ledgerTxId: 'tx-2', rejectionCode: null },
        { position: 1, spaceId: GONE, amount: '40', status: 'rejected', ledgerTxId: null, rejectionCode: 'bank.space_archived' },
      ],
    },
  ];
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

async function mount() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<IncomeSorter spaces={[live]} open={() => undefined} />));
}

describe('IncomeSorter', () => {
  it('names an archived target from the bank and says its share stays in the account', async () => {
    await mount();
    const legs = [...host.querySelectorAll('[data-testid="income-sorter-card"] > ul.money-list > li')].map((li) => ({
      text: li.textContent,
      archived: li.getAttribute('data-archived'),
    }));
    expect(legs[0]).toEqual({ text: '60% into Bills TEST', archived: null });
    expect(legs[1]!.archived).toBe('true');
    expect(legs[1]!.text).toContain('40% into Rainy day TEST');
    expect(legs[1]!.text).toContain('Rainy day TEST was archived, so its share stays in your account.');
    // The archived share counts toward what stays in the account.
    expect(legs[2]).toEqual({ text: '40% stays in your account', archived: null });
    const run = host.querySelector('[data-testid="income-sorter-run"]')!.textContent;
    expect(run).toContain('40 USDT into Rainy day TEST: not moved');
    expect(host.textContent).not.toContain('no longer listed');
  });
});
