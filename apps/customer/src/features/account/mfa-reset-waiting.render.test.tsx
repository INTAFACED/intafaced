// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. A waiting reset of the second step in Security (J-identity-05 #3): what identity's `mfaReset.status`
// answers decides the card; "Stop this reset" calls `mfaReset.cancel` and says what happened.
const USER = '12345678-1234-4234-8234-123456789abc';
const RESET = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const world = vi.hoisted(() => ({
  status: [] as unknown[],
  cancel: (() => Promise.resolve({})) as () => Promise<unknown>,
  asked: [] as unknown[],
}));
const api = {
  query: (...args: unknown[]) => {
    world.asked.push(args.slice(0, 3));
    return Promise.resolve(world.status.length > 1 ? world.status.shift() : world.status[0]);
  },
  mutate: (...args: unknown[]) => {
    world.asked.push(args.slice(0, 3));
    return world.cancel();
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: USER, api }) }));

import { MfaResetWaiting } from './MfaResetWaiting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const waiting = {
  ok: true,
  data: { waiting: { resetId: RESET, waitingSince: '2026-10-24T10:00:00.000Z', completesAt: '2026-10-25T10:00:00.000Z' } },
};
const nothing = { ok: true, data: { waiting: null } };

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function show(...status: unknown[]) {
  world.status = status;
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<MfaResetWaiting />));
  await settle();
}
const stopButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Stop this reset');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.asked = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('a waiting second-step reset in Security', () => {
  it('draws nothing when no reset waits', async () => {
    await show(nothing);
    expect(world.asked).toEqual([['identity', 'mfaReset.status', undefined]]);
    expect(host.textContent).toBe('');
  });

  it('says when the factor goes, and "Stop this reset" stops it', async () => {
    world.cancel = () => Promise.resolve({ ok: true, data: { cancelled: true } });
    await show(waiting, nothing);
    expect(host.querySelector('[role=alert]')!.textContent).toContain('your authenticator app and its recovery codes are removed after');
    await act(async () => stopButton()!.click());
    await settle();
    expect(world.asked).toContainEqual(['identity', 'mfaReset.cancel', {}]);
    expect(host.querySelector('[role=status]')!.textContent).toBe('The reset was stopped. Your authenticator app stays on.');
    expect(stopButton()).toBeUndefined();
  });

  it('a reset that already ended says nothing changed', async () => {
    world.cancel = () => Promise.resolve({ ok: true, data: { cancelled: false } });
    await show(waiting, nothing);
    await act(async () => stopButton()!.click());
    await settle();
    expect(host.querySelector('[role=status]')!.textContent).toBe('This reset already ended. Nothing changed.');
  });

  it('an API key or sub-account is refused in words, and the reset still shows', async () => {
    world.cancel = () => Promise.resolve({ ok: false, reason: 'forbidden', code: 'identity.delegated_refused', message: 'refused' });
    await show(waiting);
    await act(async () => stopButton()!.click());
    await settle();
    expect(host.querySelector('.error-text')!.textContent).toContain('cannot stop a reset');
    expect(stopButton()).toBeDefined();
  });

  it('a failed read says so with a retry', async () => {
    await show({ ok: false, reason: 'unreachable', message: 'Identity unavailable' });
    expect(host.querySelector('h2')!.textContent).toBe('Second step reset waiting');
    expect([...host.querySelectorAll('button')].some((button) => /retry|try again/i.test(button.textContent ?? ''))).toBe(true);
  });
});
