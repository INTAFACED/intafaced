// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The balance's figure (number-flow) reads the motion preference when it loads, and happy-dom has none to give (the
// render-record run gives it a browser's answer). Here it is drawn as its static text; the real figure is in the pictures.
vi.mock('@intafaced/ui', async (original) => {
  const real = await original<typeof import('@intafaced/ui')>();
  return {
    ...real,
    HeroNumber: ({ value, prefix }: { value: string; prefix?: string }) => <span data-slot="hero-number">{`${prefix ?? ''}${value}`}</span>,
  };
});

// Signed out, the boot refresh answered: the kit page needs no session, and nothing on it reads.
vi.mock('../../features/session/session', async (original) => {
  const real = await original<typeof import('../../features/session/session')>();
  const api = {
    query: () => new Promise(() => undefined),
    mutate: () => new Promise(() => undefined),
    canWrite: () => false,
    call(
      this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
      record: { kind: string; module: string; path: string; output: unknown },
      input?: unknown,
      opts?: unknown,
    ) {
      return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
        record.module,
        record.path,
        input,
        record.output,
        opts,
      ]);
    },
  };
  const value = {
    session: null,
    userId: null,
    api,
    restoring: false,
    restoreFailed: false,
    retryRestore: () => undefined,
    commit: () => undefined,
    clear: () => undefined,
    logout: async () => ({ ok: true, data: { ok: true } }),
    retryLogout: async () => ({ ok: true, data: { ok: true } }),
    notice: null,
    subAccountWaiting: false,
    mode: 'Personal',
    profiles: { list: [], business: null, select: () => undefined },
    enterSubAccount: async () => ({ ok: false }),
    leaveSubAccount: async () => ({ ok: false }),
  };
  return { ...real, useSession: () => value as never, useApi: () => api as never };
});

import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await import('./VoltKit');
}, 60_000);

let host: HTMLDivElement;
let root: Root;
const html = document.documentElement;

beforeEach(() => {
  delete html.dataset.look;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function open(path: string) {
  history.replaceState(null, '', path);
  await act(async () => root.render(<App />));
  await act(async () => {
    await vi.waitFor(() =>
      expect(Boolean(host.querySelector('[data-testid="volt-kit"]')) || Boolean(host.textContent?.includes('Page not found'))).toBe(true),
    );
  });
}

// The blocks intafaced issue 9302 lists, in its order.
const BLOCKS = ['colour', 'type', 'balance', 'object', 'buttons', 'inputs', 'rows', 'bars', 'chart', 'people', 'states', 'sheet'];

describe('the Volt kit page (intafaced issue 9302), with Volt the only look (issue 9315)', () => {
  it('/kit draws every block the issue lists, each from the shipped parts, with no switch on the root', async () => {
    expect(html.dataset.look).toBeUndefined();
    expect(html.dataset.direction).toBeUndefined();
    await open('/kit');
    const kit = host.querySelector('[data-testid="volt-kit"]');
    expect(kit).not.toBeNull();
    expect([...kit!.querySelectorAll('[data-block]')].map((b) => b.getAttribute('data-block'))).toEqual(BLOCKS);
    expect(kit!.querySelector('[data-testid="volt-stack"]'), 'the money object is Home’s own VoltStack').not.toBeNull();
    expect(kit!.querySelector('.home-total [data-slot="hero-number"]'), 'the balance is a HeroNumber in Home’s total').not.toBeNull();
    expect(kit!.querySelector('.lt-chart .lt-chart-area[data-soft]'), 'the chart is the soft AreaChart').not.toBeNull();
    expect(kit!.querySelectorAll('.lt-people .lt-person').length, 'quick send: add, then five people').toBe(6);
    expect(kit!.querySelector('.mobile-doors'), 'the tab bar is the shipped MobileTabs').not.toBeNull();
    expect(kit!.querySelectorAll('[data-slot="button"][data-variant="primary"]').length).toBeGreaterThan(0);
  });
});
