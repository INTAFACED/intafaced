// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The session as the room sees it: the context is always there; its `session` is null until the boot refresh answers.
const state = vi.hoisted(() => ({ restoring: true, session: null as null | { accessToken: string; userId: string } }));
vi.mock('../../../features/session/session', async (original) => ({
  ...(await original<typeof import('../../../features/session/session')>()),
  useSession: () => ({ restoring: state.restoring, session: state.session, userId: state.session?.userId ?? null }),
  useApi: () => ({}),
}));
vi.mock('./live', () => ({
  useLive: () => ({ status: 'loading', data: null, failure: null, reload: () => {}, at: null }),
}));

import { SignalsRoom } from './SignalsRoom';
import { WebhooksRoom } from './WebhooksRoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state.restoring = true;
  state.session = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const publishForm = () => host.querySelector('form[aria-label="Publish a signal"]');

// J-copy-bots-otc-22 #4 (#8342): the form showed before the boot refresh brought a token, so a fast Publish went out
// with none and svc-edge answered 401 "Authentication required".
describe('signals and webhooks wait for the session itself, not its context (#8342)', () => {
  it('shows no publish form while the boot refresh runs, then the form once it brings a session', async () => {
    await act(async () => root.render(<SignalsRoom path="/trade/bots/signals/publish" />));
    expect(publishForm()).toBeNull();
    expect(host.textContent).not.toContain('You are signed out');

    state.restoring = false;
    state.session = { accessToken: 'session-token', userId: 'u1' };
    await act(async () => root.render(<SignalsRoom path="/trade/bots/signals/publish" />));
    expect(publishForm()).not.toBeNull();
  });

  it('tells someone the boot refresh found signed out to sign in, with no form', async () => {
    state.restoring = false;
    await act(async () => root.render(<SignalsRoom path="/trade/bots/signals/publish" />));
    expect(publishForm()).toBeNull();
    expect(host.textContent).toContain('Sign in to publish a signal.');
  });

  it('shows no webhook controls to someone signed out', async () => {
    state.restoring = false;
    await act(async () => root.render(<WebhooksRoom />));
    expect(host.textContent).toContain('Sign in to make a webhook.');
  });
});
