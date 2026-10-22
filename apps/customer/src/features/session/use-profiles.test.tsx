// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../shared/api';
import { savePreferences } from '../../shared/preferences';
import { useProfiles, type Profiles } from './use-profiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const USER = '00000000-0000-4000-8000-000000000001';
const business = (id: string, name: string, status = 'active') => ({
  id,
  name,
  assetId: 'USDT',
  spendThreshold: '0',
  status,
  createdAt: '2026-10-20T00:00:00.000Z',
});

let host: HTMLDivElement;
let root: Root | null = null;
let latest: Profiles | null = null;
let reads: Array<{ module: string; procedure: string; input: unknown }> = [];

function Probe({ api, userId }: { api: ApiClient; userId: string | null }) {
  latest = useProfiles(api, userId);
  return null;
}
const fakeApi = (answer: () => unknown): ApiClient =>
  ({
    query: async (module: string, procedure: string, input: unknown) => {
      reads.push({ module, procedure, input });
      return answer();
    },
  }) as unknown as ApiClient;
async function mount(api: ApiClient, userId: string | null = USER) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<Probe api={api} userId={userId} />));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  latest = null;
  reads = [];
  localStorage.clear();
  savePreferences({ activeProfile: 'personal' });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('useProfiles', () => {
  it('reads the bank business list with an explicit page size and offers what comes back', async () => {
    await mount(fakeApi(() => ({ ok: true, data: [business('b1', 'TEST Coffee'), business('b2', 'TEST Closed', 'closed')] })));
    expect(reads).toEqual([{ module: 'bank', procedure: 'business.list', input: { limit: 50 } }]);
    expect(latest?.status).toBe('ready');
    expect(latest?.businesses.map((row) => row.name)).toEqual(['TEST Coffee']);
    expect(latest?.active).toBe('personal');
  });

  it('puts the person in a business they chose and belong to', async () => {
    savePreferences({ activeProfile: 'business:b1' });
    await mount(fakeApi(() => ({ ok: true, data: [business('b1', 'TEST Coffee')] })));
    expect(latest?.active).toBe('business:b1');
    expect(latest?.business?.name).toBe('TEST Coffee');
    expect(latest?.notice).toBeNull();
  });

  it('falls back to Personal with a notice when the stored business is not theirs, and does not rewrite the stored choice', async () => {
    savePreferences({ activeProfile: 'business:removed' });
    await mount(fakeApi(() => ({ ok: true, data: [business('b1', 'TEST Coffee')] })));
    expect(latest?.active).toBe('personal');
    expect(latest?.business).toBeNull();
    expect(latest?.notice).toBe('gone');
    expect(JSON.parse(localStorage.getItem('intafaced.customer.view.v1') ?? '{}').activeProfile).toBe('business:removed');
  });

  it('shows Personal only, marked unread, when the bank list cannot be read, and offers no business', async () => {
    savePreferences({ activeProfile: 'business:b1' });
    await mount(fakeApi(() => ({ ok: false, reason: 'error', message: 'bank.business_list_limit_unset' })));
    expect(latest?.status).toBe('unread');
    expect(latest?.businesses).toEqual([]);
    expect(latest?.active).toBe('personal');
    expect(latest?.notice).toBeNull();
  });

  it('reads nothing when signed out', async () => {
    await mount(
      fakeApi(() => ({ ok: true, data: [] })),
      null,
    );
    expect(reads).toEqual([]);
    expect(latest?.active).toBe('personal');
  });
});
