// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANK_CALENDAR_WINDOW } from '@intafaced/contracts/bank-calendar-procedures';
import { createApiClient } from '../../shared/api';

/**
 * `useBankRecord` reads one bank call through its record: the path and input come from the record, and nothing is sent
 * while it is switched off.
 */
const seen: string[] = [];
let reply: unknown = { result: { data: { from: '2026-01-01', to: '2026-01-31', items: [], sources: [] } } };
const api = createApiClient({
  fetch: async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(reply));
  },
});
vi.mock('../session', async (original) => ({
  ...(await original<typeof import('../session')>()),
  useSession: () => ({ api, userId: 'user-1' }),
}));
import { useBankRecord } from './components';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => void seen.splice(0));

async function render(useRead: () => { resource: { status: string } }) {
  const states: string[] = [];
  function Probe() {
    states.push(useRead().resource.status);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  await vi.waitFor(() => expect(states.at(-1)).not.toBe('loading'));
  act(() => root.unmount());
  return states.at(-1);
}

const INPUT = { from: '2026-01-01', days: 31, limit: 5 };

describe('useBankRecord: a bank read through its record', () => {
  it("sends the record's path with the input and reads the answer", async () => {
    expect(await render(() => useBankRecord(BANK_CALENDAR_WINDOW, INPUT))).toBe('ready');
    expect(seen).toEqual([`/api/bank/trpc/calendar.window?input=${encodeURIComponent(JSON.stringify(INPUT))}`]);
  });
  it('sends nothing while it is switched off', async () => {
    expect(await render(() => useBankRecord(BANK_CALENDAR_WINDOW, INPUT, false))).toBe('failed');
    expect(seen).toEqual([]);
  });
  it('reads an answer the record refuses as failed, never as data', async () => {
    const good = reply;
    reply = { result: { data: { from: '2026-01-01', items: 'not a list' } } };
    try {
      expect(await render(() => useBankRecord(BANK_CALENDAR_WINDOW, INPUT))).toBe('failed');
      expect(seen).toHaveLength(1);
    } finally {
      reply = good;
    }
  });
});
