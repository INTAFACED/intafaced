// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { P2PBlocker } from './p2p-blocker';
import type { PersonalPayApi } from './pay-api';

/** The P2P rooms name their registry blocker, the owner's instrument encryption provider, in every health state. */

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

const healthy = (instrumentKeyProvider: 'none' | 'local-test') => ({
  ok: true as const,
  data: {
    ok: true as const,
    service: 'svc-p2p' as const,
    moderationConfigured: false,
    moderation: { configured: false },
    offerLimitsConfigured: false,
    offerLimitsPosture: 'unset' as const,
    instrumentKmsConfigured: false as const,
    instrumentKeyProvider,
  },
});

async function render(health: () => Promise<unknown>) {
  const pay = { health } as unknown as PersonalPayApi;
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<P2PBlocker pay={pay} />));
  await act(async () => {});
  return host.querySelector('[data-testid="p2p-blocker"]')?.textContent ?? null;
}

describe('P2PBlocker', () => {
  it('on the test stack, says details are sealed with a TEST key and live ads need the owner’s provider', async () => {
    const text = await render(async () => healthy('local-test'));
    expect(text).toContain('sealed with a TEST key');
    expect(text).toContain('need the owner’s instrument encryption provider');
  });

  it('with no provider, says new details and ads need it', async () => {
    const text = await render(async () => healthy('none'));
    expect(text).toContain('New payment details and new ads need the owner’s instrument encryption provider');
    expect(text).not.toContain('TEST key');
  });

  it('when health cannot be read, still names the blocker rather than going silent', async () => {
    const text = await render(async () => ({ ok: false, reason: 'unavailable', message: 'svc-p2p unreachable', code: 'pay.unavailable' }));
    expect(text).toContain('need the owner’s instrument encryption provider');
  });
});
