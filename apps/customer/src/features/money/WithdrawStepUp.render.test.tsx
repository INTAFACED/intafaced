// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: {} }) }));
const mint = vi.fn();
vi.mock('./withdraw-step-up', async (original) => ({
  ...(await original<typeof import('./withdraw-step-up')>()),
  mintWithdrawToken: (...args: unknown[]) => mint(...args),
}));
import { WithdrawStepUp } from './WithdrawStepUp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  mint.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function show(run: (token: string) => Promise<unknown>, outer: (event: never) => void) {
  root = createRoot(host);
  const mounted = root;
  await act(async () =>
    mounted.render(
      <form onSubmit={outer}>
        <WithdrawStepUp run={run as never} onDone={() => undefined} onCancel={() => undefined} />
      </form>,
    ),
  );
}
async function submitCode(code: string) {
  const input = document.querySelector('input[name="withdraw-stepup-code"]') as HTMLInputElement;
  await act(async () => setValue(input, code));
  const form = input.closest('form')!;
  await act(async () => void form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('the withdrawal confirmation dialog', () => {
  it('keeps its submit to itself, so a caller’s own form never sees a code being entered', async () => {
    const outer = vi.fn((event: Event) => event.preventDefault());
    mint.mockResolvedValue({ ok: false, reason: 'error', message: 'bad', code: 'auth.mfa_invalid' });
    await show(vi.fn(), outer);
    await submitCode('123456');
    expect(outer).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('That code didn’t match');
  });

  it('hands the token only to the action, and keeps the dialog open with the service’s words when the action is refused', async () => {
    mint.mockResolvedValue({ ok: true, data: { accessToken: 'tok', expiresAt: '2026-10-20T16:00:00Z' } });
    const run = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'error', message: 'That address is already listed.', code: 'allowlist.address_listed' });
    await show(run, vi.fn());
    await submitCode('123456');
    expect(run).toHaveBeenCalledWith('tok');
    expect(document.body.textContent).toContain('That address is already listed.');
    expect(document.body.textContent).not.toContain('tok');
  });
});
