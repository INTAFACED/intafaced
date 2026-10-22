// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. Each test chooses what identity's `factorStatus` answers.
const USER = '12345678-1234-4234-8234-123456789abc';
const world = vi.hoisted(() => ({ answer: (() => Promise.resolve({})) as () => Promise<unknown>, asked: [] as unknown[] }));
const api = {
  query: (...args: unknown[]) => {
    world.asked.push(args.slice(0, 3));
    return world.answer();
  },
};
vi.mock('../session/session', () => ({
  useSession: () => ({ userId: USER, api }),
}));

import { SecurityChecklist } from './SecurityChecklist';
import { factorStatus } from './security-checklist';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const none = { platform: 0, cross_device: 0, security_key: 0, unknown: 0 };
const floor = { floor: ['money_out', 'security_change'], policy: null };
const passwordOnly = {
  password: true,
  authenticator: { on: false, label: null },
  passkeys: { count: 0, kinds: none },
  recoveryCodesLeft: 0,
  secondStepRequired: floor,
  checklist: ['second_factor', 'passkey', 'authenticator', 'recovery_codes'].map((key) => ({ key, done: false })),
};

async function show(answer: unknown) {
  world.answer = () => Promise.resolve(answer);
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<SecurityChecklist />));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
const rows = () => [...host.querySelectorAll('li')].map((row) => row.textContent ?? '');

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

describe('Security checklist', () => {
  it('asks only for the signed-in account: the read takes no input', async () => {
    await show({ ok: true, data: passwordOnly });
    expect(world.asked).toEqual([['identity', 'factorStatus', undefined]]);
  });

  it('a password-only account sees every item open with the reason it matters', async () => {
    await show({ ok: true, data: passwordOnly });
    const list = rows();
    expect(list[0]).toContain('A second step at sign-in');
    expect(list[0]).toContain('Not yet');
    expect(list[0]).toContain('anyone who learns it can sign in');
    expect(list[3]).toContain('a recovery code is how you get back in');
    expect(host.textContent).not.toMatch(/\d+ ?%|score/i);
  });

  it('with no owner policy, money out and security changes still carry "Required", and nothing else does', async () => {
    await show({ ok: true, data: passwordOnly });
    const required = rows().filter((row) => row.includes('Required'));
    expect(required).toEqual(['Moving money out Required', 'Changing how you sign in or secure your account Required']);
    expect(host.textContent).toContain('The owner has not set further actions');
  });

  it('before any second step is on, it says the password alone can change sign-in and money cannot move out', async () => {
    await show({ ok: true, data: passwordOnly });
    expect(host.querySelector('h3')?.textContent).toBe('Needs a second step once you have one');
    expect(host.textContent).toContain('your password alone can change how you sign in, and money cannot move out');
    expect(host.textContent).not.toContain('Always needs a second step');
  });

  it('a passkey and an authenticator are both listed as done, with count, label and codes left', async () => {
    await show({
      ok: true,
      data: {
        ...passwordOnly,
        authenticator: { on: true, label: 'Phone app' },
        passkeys: { count: 2, kinds: { ...none, platform: 1, security_key: 1 } },
        recoveryCodesLeft: 8,
        checklist: passwordOnly.checklist.map((item) => ({ ...item, done: true })),
      },
    });
    const list = rows();
    expect(list.slice(0, 4).every((row) => row.includes('Done') && !row.includes('Not yet'))).toBe(true);
    expect(list[1]).toContain('2 on this account');
    expect(list[2]).toContain('Phone app');
    expect(list[3]).toContain('8 left');
    expect(host.textContent).not.toContain('phishing cannot take it');
    expect(host.querySelector('h3')?.textContent).toBe('Always needs a second step');
    expect(host.textContent).not.toContain('your password alone');
  });

  it('a failed read is an error with a retry, never "off"', async () => {
    await show({ ok: false, reason: 'error', message: 'down' });
    expect(host.textContent).not.toContain('Not yet');
    expect(host.querySelector('button')).not.toBeNull();
  });
});

describe('factorStatus answer', () => {
  it('accepts the service shape and refuses a negative count or a policy it does not know', () => {
    expect(factorStatus.safeParse(passwordOnly).success).toBe(true);
    expect(factorStatus.safeParse({ ...passwordOnly, recoveryCodesLeft: -1 }).success).toBe(false);
    expect(factorStatus.safeParse({ ...passwordOnly, secondStepRequired: { ...floor, policy: ['sign_in'] } }).success).toBe(false);
  });
});
