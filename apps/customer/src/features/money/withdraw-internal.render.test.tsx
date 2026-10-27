// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** W-withdraw-14 on the Withdraw form: an address of another INTAFACED account settles inside, once, with a kept reference. */
const query = vi.fn();
const mutate = vi.fn();
// The form also reads the caller's campaign rewards (the locked-rewards note): none here.
const noRewards = { ok: true, data: { rewards: [], totals: [], more: false } };
// Only where an address leads is answered here; the form's other reads (limits, the address book) are not, and say so.
const route = (module: string, procedure: string, ...rest: unknown[]) =>
  module === 'campaigns'
    ? Promise.resolve(noRewards)
    : procedure === 'withdrawal.destination'
      ? query(module, procedure, ...rest)
      : Promise.resolve({ ok: false, reason: 'unreachable', message: 'not in this test' });
vi.mock('../session/session', () => ({ useSession: () => ({ userId: 'u1', api: { query: route, mutate } }) }));
vi.mock('./holdings', () => ({
  useHoldings: () => ({
    resource: { status: 'ready', data: { assets: [{ assetId: 'USDT', available: '80' }], spaces: [], holdings: [] } },
    reload: () => undefined,
  }),
}));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
// The real dialog asks identity for a step-up token; here "Confirm" hands the action a TEST token and shows its refusal.
vi.mock('./WithdrawStepUp', async (original) => {
  const { useState } = await import('react');
  return {
    ...(await original<typeof import('./WithdrawStepUp')>()),
    WithdrawStepUp: ({ run, onDone }: { run: (token: string) => Promise<{ ok: boolean; message?: string }>; onDone: () => void }) => {
      const [problem, setProblem] = useState('');
      return (
        <div role="dialog">
          <button
            type="button"
            onClick={async () => {
              const answer = await run('TEST-token');
              if (answer.ok) onDone();
              else setProblem(answer.message ?? '');
            }}
          >
            Confirm
          </button>
          <p data-testid="dialog-problem">{problem}</p>
        </div>
      );
    },
  };
});
import { WithdrawForm } from './WithdrawForm';

const FRIEND = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID = '33333333-3333-4333-8333-333333333333';
const sent = {
  ok: true,
  data: {
    id: ID,
    userId: '11111111-1111-4111-8111-111111111111',
    assetId: 'USDT',
    amount: '10',
    rail: 'internal',
    destination: { kind: 'crypto', ref: FRIEND },
    clientRef: 'x',
    railRef: 'bank-tx-1',
    attempts: 0,
    failureCode: null,
    status: 'sent',
    createdAt: '2026-10-24T08:00:00.000Z',
  },
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  query.mockReset();
  mutate.mockReset();
  sessionStorage.clear();
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
const input = (label: string) =>
  [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent === label)!.querySelector('input')!;
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement | undefined;
const click = async (name: string) => act(async () => void button(name)!.click());

async function fill(address: string, amount: string) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<WithdrawForm />));
  await act(async () => setValue(input('Or enter a new address'), address));
  await act(async () => setValue(input('Amount'), amount));
  // The destination is asked once the address is whole, after a short pause.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
}

describe('Withdraw to another INTAFACED account', () => {
  it('says it settles inside with no fee, sends once with the internal rail after a confirmation, and shows it sent', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    mutate.mockResolvedValue(sent);
    await fill(FRIEND, '10');
    expect(query).toHaveBeenCalledWith(
      'pay',
      'withdrawal.destination',
      { destination: { kind: 'crypto', ref: FRIEND } },
      expect.anything(),
      expect.anything(),
    );
    const note = document.querySelector('[data-testid="withdraw-destination"]')!;
    expect(note.getAttribute('data-kind')).toBe('internal');
    expect(note.textContent).toContain('It arrives at once, with no network fee.');
    expect(document.body.textContent).toContain('Inside INTAFACED, no network');
    expect(document.body.textContent).toContain('No fee');

    await click('Send inside INTAFACED');
    await click('Confirm');
    expect(mutate).toHaveBeenCalledTimes(1);
    const [module, procedure, body, , options] = mutate.mock.calls[0]!;
    expect([module, procedure]).toEqual(['pay', 'withdrawal.create']);
    expect(body).toMatchObject({ assetId: 'USDT', amount: '10', railId: 'internal', destination: { kind: 'crypto', ref: FRIEND } });
    expect(body.clientRef).toMatch(/^internal-[0-9a-f-]{36}$/);
    expect(options).toEqual({ bearer: 'TEST-token' });
    const outcome = document.querySelector('[data-testid="withdraw-outcome"]')!;
    expect(outcome.textContent).toContain('10 USDT reached the other account at once, with no fee.');
    expect(outcome.querySelector('a')!.getAttribute('href')).toBe(`/uc/withdraw?withdrawalId=${ID}`);
  });

  it('keeps the reference when the answer is lost, so confirming again finishes the same withdrawal', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    mutate.mockResolvedValueOnce({ ok: false, reason: 'unreachable', message: 'network' }).mockResolvedValueOnce(sent);
    await fill(FRIEND, '10');
    await click('Send inside INTAFACED');
    await click('Confirm');
    expect(document.querySelector('[data-testid="dialog-problem"]')!.textContent).toContain('never sends twice');
    await click('Confirm');
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]![2].clientRef).toBe(mutate.mock.calls[0]![2].clientRef);
    expect(document.querySelector('[data-testid="withdraw-outcome"]')).not.toBeNull();
  });

  it('keeps a lost send across a reload with its fields locked, and finishes it under the same reference and terms', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    mutate.mockResolvedValueOnce({ ok: false, reason: 'unreachable', message: 'network' }).mockResolvedValueOnce(sent);
    await fill(FRIEND, '10');
    await click('Send inside INTAFACED');
    await click('Confirm');
    expect(input('Amount').readOnly).toBe(true);
    expect(input('Or enter a new address').readOnly).toBe(true);

    // The page reloads: the form comes back on the same send, offering only to finish it.
    act(() => root?.unmount());
    root = createRoot(host);
    const again = root;
    query.mockResolvedValue({ ok: true, data: { kind: 'unavailable', reason: 'unavailable' } });
    await act(async () => again.render(<WithdrawForm />));
    expect(input('Amount').value).toBe('10');
    expect(input('Or enter a new address').value).toBe(FRIEND);
    await click('Confirm again to finish');
    await click('Confirm');
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]![2]).toEqual(mutate.mock.calls[0]![2]);
    expect(document.querySelector('[data-testid="withdraw-outcome"]')).not.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps a send whose ask is still in flight across a reload, and finishes it under the same reference', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    // The first ask never answers: the tab reloads (or crashes) while it is in flight.
    mutate.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(sent);
    await fill(FRIEND, '10');
    await click('Send inside INTAFACED');
    await click('Confirm');
    act(() => root?.unmount());
    root = createRoot(host);
    const again = root;
    query.mockResolvedValue({ ok: true, data: { kind: 'unavailable', reason: 'unavailable' } });
    await act(async () => again.render(<WithdrawForm />));
    expect(input('Amount').value).toBe('10');
    expect(input('Amount').readOnly).toBe(true);
    await click('Confirm again to finish');
    await click('Confirm');
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]![2]).toEqual(mutate.mock.calls[0]![2]);
    expect(sessionStorage.length).toBe(0);
  });

  it('closes a lost send when svc-bank answers the retry with a refusal, since nothing moved', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    mutate
      .mockResolvedValueOnce({ ok: false, reason: 'unreachable', message: 'network' })
      .mockResolvedValueOnce({ ok: false, reason: 'error', message: 'refused', code: 'pay.internal_settlement_refused' });
    await fill(FRIEND, '10');
    await click('Send inside INTAFACED');
    await click('Confirm');
    await click('Confirm');
    expect(document.querySelector('[data-testid="withdraw-refusal"]')!.textContent).toContain('nothing moved');
    expect(input('Amount').readOnly).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it('refuses your own address on the form, with the send button off', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'self' } });
    await fill(FRIEND, '10');
    const note = document.querySelector('[data-testid="withdraw-destination"]')!;
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.textContent).toContain('A withdrawal to yourself is refused.');
    expect(button('Review withdrawal')!.disabled).toBe(true);
    expect(button('Send inside INTAFACED')).toBeUndefined();
  });

  it('closes on a named refusal and says nothing moved, with its reference', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    mutate.mockResolvedValue({ ok: false, reason: 'error', message: 'refused', code: 'pay.internal_settlement_refused' });
    await fill(FRIEND, '10');
    await click('Send inside INTAFACED');
    await click('Confirm');
    const refusal = document.querySelector('[data-testid="withdraw-refusal"]')!;
    expect(refusal.textContent).toBe('The transfer was refused and nothing moved. Reference: pay.internal_settlement_refused');
  });

  it('keeps an outside address on the switched-off review, and an amount above the balance off with its reason', async () => {
    query.mockResolvedValue({ ok: true, data: { kind: 'external' } });
    await fill(FRIEND, '10');
    expect(document.querySelector('[data-testid="withdraw-destination"]')).toBeNull();
    expect(button('Review withdrawal')!.disabled).toBe(true);
    act(() => root?.unmount());
    root = null;
    query.mockResolvedValue({ ok: true, data: { kind: 'internal' } });
    await fill(FRIEND, '81');
    expect(button('Send inside INTAFACED')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Enter an amount you have available to send.');
  });
});
