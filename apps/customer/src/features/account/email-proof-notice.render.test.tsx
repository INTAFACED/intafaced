// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. Each test chooses who is signed in and what identity's `me` answers.
const USER = '12345678-1234-4234-8234-123456789abc';
const world = vi.hoisted(() => ({ userId: null as string | null, me: (() => Promise.resolve({})) as () => Promise<unknown> }));
// One api object, as the real session keeps: the notice re-reads only when the api or the user changes.
const api = { query: () => world.me() };
vi.mock('../session/session', () => ({
  useSession: () => ({ userId: world.userId, api }),
}));

import { EmailProofNotice } from './EmailProofNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const me = (data: unknown) => () => Promise.resolve({ ok: true, data });

async function show() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<EmailProofNotice />));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = USER;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('email proof notice on trade rooms', () => {
  it('names the blocker and links to Account when the email is unproved', async () => {
    world.me = me({ userId: USER, handle: 'test_user', emailVerified: false });
    await show();
    expect(host.querySelector('h2')?.textContent).toBe('Confirm your email to place orders');
    expect(host.textContent).toContain('cancel open orders');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/uc/account');
  });

  it.each([
    ['a proved email', me({ userId: USER, handle: 'test_user', emailVerified: true })],
    ['a server that does not report proof', me({ userId: USER, handle: 'test_user' })],
    ['an answer about another user', me({ userId: '22222222-2222-4222-8222-222222222222', handle: 'x', emailVerified: false })],
    ['a failed read', () => Promise.resolve({ ok: false, reason: 'error', message: 'down' })],
  ])('shows nothing for %s', async (_label, answer) => {
    world.me = answer;
    await show();
    expect(host.innerHTML).toBe('');
  });

  it('shows nothing when signed out', async () => {
    world.userId = null;
    world.me = me({ userId: USER, handle: 'test_user', emailVerified: false });
    await show();
    expect(host.innerHTML).toBe('');
  });
});
