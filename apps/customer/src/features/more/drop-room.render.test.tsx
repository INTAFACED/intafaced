// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../session';
import { DropRoom } from './DropRoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;
const fetcher = vi.fn();

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ result: { data } }), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockReset();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('/campaigns/drops copy (#6177)', () => {
  it('uses plain token-launch copy without "Token generation event" or raw uppercase Tag pills', async () => {
    fetcher.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('waitlist.mine')) return jsonResponse(null);
      if (target.includes('drops.room')) {
        return jsonResponse({
          season: null,
          drops: [],
          tge: {
            schedule: null,
            networks: [
              { network: 'testnet', label: 'Testnet', blocker: 'launch.schedule_unset' },
              { network: 'mainnet', label: 'Mainnet', blocker: 'audit.external' },
            ],
          },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 401 });
    });
    root = createRoot(host);
    const mounted = root;
    await act(async () =>
      mounted.render(
        <SessionProvider>
          <DropRoom />
        </SessionProvider>,
      ),
    );
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[data-testid="drop-tge"]')).not.toBeNull());
    });
    const tge = host.querySelector('[data-testid="drop-tge"]')!;
    expect(host.textContent).not.toContain('Token generation event');
    expect(tge.textContent).not.toContain('Nothing here posts, mints or signs');
    expect(tge.querySelector('[data-testid="tge-schedule"]')?.textContent).toBe('Not set');
    expect(tge.querySelector('[data-testid="tge-testnet-label"]')?.textContent).toBe('Testnet');
    expect(tge.querySelector('[data-testid="tge-testnet-label"]')?.getAttribute('data-slot')).not.toBe('tag');
    expect(tge.querySelector('[data-testid="tge-mainnet-label"]')?.textContent).toBe('Mainnet');
  });
});
