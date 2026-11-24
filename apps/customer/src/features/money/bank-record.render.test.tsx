// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineProcedure } from '@intafaced/contracts/procedure';
import { createApiClient } from '../../shared/api';
import { bankReads } from './contracts';

/**
 * `useBankRecord` is `useBankRead` through the call's record: the call-records codemod moves each
 * `useBankRead(path, input, enabled)` to `useBankRecord(RECORD, input, enabled)`, and nothing sent or answered changes.
 */
const seen: string[] = [];
const reply = { result: { data: { from: '2026-01-01', to: '2026-01-31', items: [], sources: [] } } };
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
import { useBankRead, useBankRecord } from './components';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => void seen.splice(0));

const CALENDAR = defineProcedure({
  name: 'bank.calendar.window',
  service: 'svc-bank',
  module: 'bank',
  transport: 'trpc',
  kind: 'query',
  path: 'calendar.window',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().optional() }),
  output: bankReads['calendar.window'],
  samples: [
    { verdict: 'accept', input: { limit: 5 } },
    { verdict: 'refuse', input: { limit: 0.5 } },
  ],
});

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

describe('useBankRecord: useBankRead through its record', () => {
  it('sends the same request and reads the same answer as the call by name', async () => {
    const input = { limit: 5 };
    expect(await render(() => useBankRead('calendar.window', input))).toBe('ready');
    const byName = seen.splice(0);
    expect(await render(() => useBankRecord(CALENDAR, input))).toBe('ready');
    expect(seen).toEqual(byName);
    expect(byName).toEqual([`/api/bank/trpc/calendar.window?input=${encodeURIComponent('{"limit":5}')}`]);
  });
  it('sends nothing while it is switched off, as the call by name does', async () => {
    expect(await render(() => useBankRecord(CALENDAR, {}, false))).toBe('failed');
    expect(seen).toEqual([]);
  });
});
