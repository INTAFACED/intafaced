// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { embeddedWalletCopy } from './embedded-wallet-copy';
import type { EmbeddedWalletClient } from './provider-client';
import { TradingSession } from './TradingSession';

// J-wallet-22 #8 (issue 9822): the trading session panel offers no action before the read it depends on has answered.
// On main the panel showed "Approve the builder fee" while that approval was still being read, and the button went away
// when the read said it was approved: the journey's press landed on a button that was gone and waited out its 10 minutes.
// It showed "Start trading session" the same way while this sign-in's session was still being read.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const OWNER = '0x1111111111111111111111111111111111111111';
const DOOR = {
  enabled: true,
  available: true,
  venue: { id: 'test-venue', displayName: 'TEST venue simulator', proofLevel: 'test' },
  test: true,
  builder: { address: '0x2222222222222222222222222222222222222222', feeBps: '1' },
};

/** Each read the panel makes, through the app's own client, answered only when the test says so. */
function heldApi() {
  const waiting = new Map<string, (body: unknown) => void>();
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const api = createApiClient({
    fetch: async (url) => {
      const path = new URL(String(url), 'http://app.test').pathname.replace(/^\/api\/v1/, '');
      if (path === '/venue/status') return reply(DOOR);
      if (path === '/venue/markets') return reply({ value: [] });
      return reply(await new Promise((resolve) => waiting.set(path, resolve)));
    },
  });
  const answer = async (path: string, body: unknown) => {
    const resolve = waiting.get(path);
    if (!resolve) throw new Error(`${path} was not asked`);
    await act(async () => {
      resolve(body);
      // The client reads the reply's body before it answers: a few turns of the microtask queue, no clock.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
  };
  return { api, answer };
}

const client = {} as EmbeddedWalletClient;
const panel = () => host.querySelector('[data-panel="trading-session"]');
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

describe('TradingSession', () => {
  it('offers no builder-fee approval and no session start until their reads answer', async () => {
    const { api, answer } = heldApi();
    const { t } = embeddedWalletCopy.forLocale('en');
    await act(async () =>
      root.render(
        <TradingSession
          api={api}
          userId="u1"
          wallet={{ address: OWNER, providerWalletId: 'w1', test: true } as never}
          client={client}
          providerFailure={() => ''}
          t={t}
        />,
      ),
    );
    // Both reads are out: the panel says so, offers no approval, and its Start is visible but cannot be pressed.
    expect(panel()?.getAttribute('data-session-state')).toBe('reading');
    expect(button('Approve the builder fee')).toBeUndefined();
    expect(host.textContent).toContain('Reading whether your wallet has approved our builder fee…');
    expect(host.textContent).toContain('Reading your trading session on the venue…');
    expect(button('Start trading session')?.disabled).toBe(true);

    // The approval read says not approved: now, and only now, Approve is offered.
    await answer('/venue/builder-fee-approval', null);
    expect(button('Approve the builder fee')?.disabled).toBe(false);
    expect(button('Start trading session')?.disabled).toBe(true);

    // This sign-in has no session: Start can be pressed.
    await answer('/venue/session', { venueId: 'test-venue', owner: OWNER, current: null, asOf: new Date().toISOString() });
    expect(panel()?.getAttribute('data-session-state')).toBe('none');
    expect(host.textContent).not.toContain('Reading your trading session on the venue…');
    expect(button('Start trading session')?.disabled).toBe(false);
  });

  it('never offers Approve when the read says the fee is already approved', async () => {
    const { api, answer } = heldApi();
    const { t } = embeddedWalletCopy.forLocale('en');
    await act(async () =>
      root.render(
        <TradingSession
          api={api}
          userId="u1"
          wallet={{ address: OWNER, providerWalletId: 'w1', test: true } as never}
          client={client}
          providerFailure={() => ''}
          t={t}
        />,
      ),
    );
    expect(button('Approve the builder fee')).toBeUndefined();
    await answer('/venue/builder-fee-approval', { value: '1' });
    expect(button('Approve the builder fee')).toBeUndefined();
    expect(host.querySelector('[data-builder-approved]')).not.toBeNull();
  });
});
