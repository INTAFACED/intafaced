// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only: /invite opened with no invitation link, signed in and signed out.
const world = vi.hoisted(() => ({
  userId: null as string | null,
  // One client for every render, as the session hands out.
  api: {
    canWrite: () => true,
    query: () => new Promise(() => {}),
    mutate: () => new Promise(() => {}),
    call: () => new Promise(() => {}),
  },
  session: { accessToken: 'TEST-token' },
}));
vi.mock('../session/session', async (original) => ({
  ...(await original<object>()),
  useSession: () => ({
    userId: world.userId,
    session: world.userId ? world.session : null,
    api: world.api,
  }),
}));

import { Invitation } from './Invitation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
async function open() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<Invitation />));
}
const card = () => host.querySelector('[data-testid="invitation__card"]')!.textContent;

beforeEach(() => {
  history.replaceState(null, '', '/invite');
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  world.userId = null;
});

describe('/invite with no invitation link', () => {
  it('a signed-in person is never asked to sign in, and is sent to their account invitations', async () => {
    world.userId = '12345678-1234-4234-8234-123456789abc';
    await open();
    expect(card()).toContain('Create an invitation from your account');
    expect(card()).toContain('You are signed in. Your invitation link and its records are in your account.');
    expect(card()).not.toMatch(/after sign-in/);
    expect(host.querySelector('[data-testid="invitation__primary"]')!.getAttribute('href')).toBe('/uc/promotion');
  });

  it('a signed-out visitor reads that the tools come after sign-in', async () => {
    await open();
    expect(card()).toContain('Your personal invitation tools are available after sign-in.');
  });
});
