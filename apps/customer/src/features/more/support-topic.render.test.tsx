// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', async (original) => {
  const real = await original<typeof import('../session/session')>();
  const api = {
    query: async () => ({ ok: false, reason: 'unavailable', message: 'TEST off' }),
    mutate: async () => ({ ok: false }),
    canWrite: () => true,
    // A call by its record reaches this double's query or mutate under the record's module and path.
    call(record: { kind: string; module: string; path: string }, input?: unknown): Promise<unknown> {
      const send = (record.kind === 'query' ? api.query : api.mutate) as (
        module: string,
        path: string,
        input?: unknown,
      ) => Promise<unknown>;
      return send(record.module, record.path, input);
    },
  };
  const held = { api, userId: 'user-1', session: { accessToken: 'token' } };
  return { ...real, useApi: () => api, useSession: () => held };
});

import { Support } from './Support';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a scam report from the address (J-identity-13 #2)', () => {
  it('/support/new?topic=phishing opens the form with the scam report topic', async () => {
    history.replaceState(null, '', '/support/new?topic=phishing');
    root = createRoot(host);
    await act(async () => root.render(<Support path="/support/new?topic=phishing" />));
    await act(async () => undefined);
    const select = host.querySelector('select');
    expect(select?.value).toBe('phishing');
  });
});
