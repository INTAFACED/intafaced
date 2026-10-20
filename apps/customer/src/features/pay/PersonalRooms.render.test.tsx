// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
const USER = '00000000-0000-4000-8000-000000000001';
const request = vi.fn();
vi.mock('../session/session', () => ({
  useSession: () => ({ userId: USER, session: null, api: { query: request, mutate: request, canWrite: () => true } }),
}));
const navigate = vi.fn();
vi.mock('../../app/location', () => ({ navigate: (...args: unknown[]) => navigate(...args) }));

import { PersonalRooms } from './PersonalRooms';
import { PERSONAL_ROUTES } from './personal-room-routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  localStorage.clear();
  request.mockReset();
  navigate.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

async function show(path: string) {
  root ??= createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<PersonalRooms path={path} />));
  return host.textContent ?? '';
}
const sentRow = {
  transferId: 'tr_1',
  ledgerTxId: 'tx_9',
  toUserId: '00000000-0000-4000-8000-000000000002',
  handle: 'test_friend',
  amount: '12.5',
  asset: 'USDT',
  note: 'lunch',
  at: '2026-10-01T10:00:00.000Z',
};

describe('personal Pay pages', () => {
  it('names the missing source on every page that has none, and sends no request', async () => {
    for (const route of PERSONAL_ROUTES.filter((r) => r.kind === 'refusal')) {
      const out = await show(route.pattern.replace(/:[A-Za-z]+/g, 'abc123'));
      expect(out, route.pattern).toContain('No data is shown for this page');
      expect(out, route.pattern).toMatch(/No .* (service|fee|sending limit|personal Pay preference)|not looked up/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('lists the people this device paid, from what the device remembers', async () => {
    localStorage.setItem(`intafaced.pay.sent.v1:${USER}`, JSON.stringify([sentRow]));
    const out = await show('/pay/contacts');
    expect(out).toContain('@test_friend');
    expect(out).toContain('Pay again');
    expect(host.querySelector('a[href^="/pay/send?to=test_friend"]')).not.toBeNull();
  });

  it('shows an honest empty contacts page', async () => {
    expect(await show('/pay/contacts')).toContain('No contacts on this device');
  });

  it('shows a payment this device confirmed, and says so when it has none with that id', async () => {
    localStorage.setItem(`intafaced.pay.sent.v1:${USER}`, JSON.stringify([sentRow]));
    const found = await show('/pay/history/tr_1');
    expect(found).toContain('12.5 USDT');
    expect(found).toContain('tx_9');
    expect(await show('/pay/history/tr_2')).toContain('This device has no such payment');
  });

  it('shows a request made here and refuses an unknown or malformed id', async () => {
    const path = '/pay/send?to=test_friend&amount=5&asset=USDT';
    localStorage.setItem(`intafaced.pay.requests.v1:${USER}`, JSON.stringify([{ id: 'rq_1', path, at: '2026-10-02T10:00:00.000Z' }]));
    const found = await show('/pay/request/rq_1');
    expect(found).toContain('5 USDT');
    expect(host.querySelector(`a[href="${path}"]`)).not.toBeNull();
    expect(await show('/pay/request/rq_2')).toContain('This device has no such request');
    expect(await show('/pay/request/a%2Fb')).toContain('That address is not valid');
    expect(request).not.toHaveBeenCalled();
  });

  it('opens Send filled in from a pasted payment link and rejects other text', async () => {
    await show('/pay/scan');
    const input = host.querySelector('input')!;
    const form = host.querySelector('form')!;
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    };
    await type('https://elsewhere.test/pay/send?to=test_friend');
    expect(host.textContent).toContain('That text is not a payment link from here.');
    expect(navigate).not.toHaveBeenCalled();
    for (const hostile of ['javascript:alert(1)', '//evil.test/pay/send?to=x', 'data:text/html,x']) {
      await type(hostile);
      expect(navigate, hostile).not.toHaveBeenCalled();
    }
    await type(`${location.origin}/pay/send?to=test_friend&amount=5&asset=USDT`);
    expect(navigate).toHaveBeenCalledWith('/pay/send?to=test_friend&amount=5&asset=USDT');
  });
});
