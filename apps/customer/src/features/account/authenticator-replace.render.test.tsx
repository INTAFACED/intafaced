// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only. Replacing the authenticator app in Security (J-identity-05 #4): after the swap the card shows the new
// recovery codes once, says how many other devices were signed out, and drops the codes on "I saved them".
const USER = '12345678-1234-4234-8234-123456789abc';
const CODES = ['AAAAA-11111', 'BBBBB-22222', 'CCCCC-33333'];
const world = vi.hoisted(() => ({ replaced: {} as unknown, sent: [] as string[], completed: [] as unknown[], left: 2 }));
const api = {
  query: () => Promise.resolve({ ok: true, data: { enabled: true, label: 'Old phone', enrolledAt: null, recoveryCodesLeft: world.left } }),
  mutate: (_service: string, procedure: string, input: unknown) => {
    world.sent.push(procedure);
    if (procedure === 'stepUp.complete') world.completed.push(input);
    const answers: Record<string, unknown> = {
      'stepUp.begin': { ok: true, data: { challengeId: '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d' } },
      'stepUp.complete': { ok: true, data: { stepUpApprovalId: 'approval-1' } },
      'totpManage.replaceStart': { ok: true, data: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DP', uri: 'otpauth://totp/TEST' } },
      'totpManage.replaceConfirm': world.replaced,
    };
    return Promise.resolve(answers[procedure]);
  },
};
vi.mock('../session/session', () => ({ useSession: () => ({ userId: USER, api }) }));

import { Authenticator } from './Authenticator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name);
function fill(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function replaceWith(answer: unknown, confirmCode = '123456') {
  world.replaced = answer;
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<Authenticator />));
  await settle();
  await act(async () => button('Replace')!.click());
  fill('confirm-code', confirmCode);
  await act(async () => button('Confirm')!.click());
  await settle();
  // Refused at the confirm step: there is no replace form to fill.
  if (!host.querySelector('input[name="new-code"]')) return;
  fill('new-code', '654321');
  fill('next-code', '112233');
  await act(async () => button('Replace authenticator app')!.click());
  await settle();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.sent = [];
  world.completed = [];
  world.left = 2;
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('replacing the authenticator app', () => {
  it('shows the new recovery codes once and says the other devices were signed out', async () => {
    await replaceWith({ ok: true, data: { replaced: true, recoveryCodeSpent: false, recoveryCodes: CODES, sessionsEnded: 2 } });
    expect(world.sent).toContain('totpManage.replaceConfirm');
    const codes = [...host.querySelectorAll('.security__recovery .recovery-codes li')].map((li) => li.textContent);
    expect(codes).toEqual(CODES);
    expect(host.querySelector('.security__recovery')!.textContent).toContain('Your old recovery codes no longer work');
    expect(host.querySelector('[role=status]')!.textContent).toBe(
      'Authenticator app replaced. Your name is kept. Every other device was signed out (2).',
    );
    // "I saved them" waits for the tick, then drops the codes from the page.
    expect(button('I saved them')!.disabled).toBe(true);
    const tick = host.querySelector<HTMLInputElement>('.security__recovery input[type=checkbox]')!;
    await act(async () => tick.click());
    await act(async () => button('I saved them')!.click());
    expect(host.querySelector('.security__recovery')).toBeNull();
    expect(host.textContent).not.toContain(CODES[0]);
  });

  it('a recovery code spent as proof is named, and no other device is said so', async () => {
    await replaceWith({ ok: true, data: { replaced: true, recoveryCodeSpent: true, recoveryCodes: CODES, sessionsEnded: 0 } });
    expect(host.querySelector('[role=status]')!.textContent).toBe(
      'Authenticator app replaced. Your name is kept. The recovery code you used is spent. No other device was signed in.',
    );
  });

  it('someone who lost the phone confirms with a recovery code, sent as one', async () => {
    await replaceWith(
      { ok: true, data: { replaced: true, recoveryCodeSpent: true, recoveryCodes: CODES, sessionsEnded: 1 } },
      'OLDCO-DE111',
    );
    expect(world.completed).toEqual([{ challengeId: '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d', recoveryCode: 'OLDCO-DE111' }]);
    expect(host.querySelectorAll('.security__recovery .recovery-codes li')).toHaveLength(3);
  });

  it('with one recovery code left, a recovery code is refused before anything is spent and the reset is named', async () => {
    world.left = 1;
    await replaceWith(
      { ok: true, data: { replaced: true, recoveryCodeSpent: true, recoveryCodes: CODES, sessionsEnded: 0 } },
      'OLDCO-DE111',
    );
    expect(world.sent).not.toContain('stepUp.begin');
    expect(host.querySelector('[role=alert]')!.textContent).toContain('I lost my authenticator');
  });

  it('a lost answer says the swap may have happened instead of asking to confirm again', async () => {
    await replaceWith({ ok: false, reason: 'uncertain', message: 'No answer' });
    expect(host.querySelector('.security__recovery')).toBeNull();
    expect(host.textContent).not.toContain('Confirm it is you');
    expect(host.querySelector('[role=status]')!.textContent).toContain('We could not tell whether the app was replaced');
  });

  it('a refused replace shows no codes and asks to confirm again', async () => {
    await replaceWith({ ok: false, reason: 'unauthorized', code: 'auth.mfa_invalid', message: 'Invalid two-factor code' });
    expect(host.querySelector('.security__recovery')).toBeNull();
    expect(host.textContent).toContain('Confirm it is you');
  });
});
