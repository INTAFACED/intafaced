// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const SANDBOX = '0b0e8f5e-6d64-4a4c-9a55-4c6f1d3a7e10';
const unsetBalance = {
  sandboxId: SANDBOX,
  label: 'TEST',
  asset: 'USDT',
  amount: '0',
  version: 0,
  fundAmount: null,
  resetsPerDay: null,
  resetsToday: 0,
};
const world = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  list: undefined as unknown as () => Promise<unknown>,
  get: undefined as unknown as () => Promise<unknown>,
  create: undefined as unknown as (name: string) => Promise<unknown>,
  createKey: undefined as unknown as (asked: unknown) => Promise<unknown>,
  fund: undefined as unknown as (read: unknown) => Promise<unknown>,
  reset: undefined as unknown as (read: unknown) => Promise<unknown>,
  balance: undefined as unknown as () => Promise<unknown>,
}));
vi.mock('../../session/session', () => ({ useSession: () => ({ userId: world.userId, api: {} }) }));
vi.mock('./sandbox-api', async (original) => {
  const real = await original<typeof import('./sandbox-api')>();
  return {
    ...real,
    readSandboxes: () => world.list(),
    readSandbox: () => world.get(),
    createSandbox: (_api: unknown, _user: string, _listed: unknown, name: string) => world.create(name),
    createSandboxKey: (_api: unknown, _user: string, _detail: unknown, asked: unknown) => world.createKey(asked),
    fundSandbox: (_api: unknown, _user: string, read: unknown) => world.fund(read),
    resetSandbox: (_api: unknown, _user: string, read: unknown) => world.reset(read),
    readSandboxBalance: () => world.balance(),
  };
});

import { SandboxRoutes } from './SandboxRoutes';
import { sandboxRoute } from './sandbox-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const record = { id: SANDBOX, name: 'development', createdAt: '2026-10-29T14:00:00.000Z' };
const keyRecord = {
  id: '5d1f7b7e-1c2a-4f0e-8d5c-2b3c4d5e6f70',
  name: 'bot',
  prefix: 'ifc_test_ab12',
  mode: 'sandbox',
  scopes: ['pay:read'],
  ipAllowlist: [],
  requireSignature: false,
  createdAt: '2026-10-29T14:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revoked: false,
};
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = 'u1';
  world.list = async () => ({ ok: true, data: { sandboxes: [record], cap: { limit: null, held: 1 }, baseUrl: 'http://sandbox.test' } });
  world.get = async () => ({ ok: true, data: { sandbox: record, keys: [], baseUrl: 'http://sandbox.test' } });
  world.balance = async () => ({ ok: true, data: unsetBalance });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});
async function show(path: string) {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<SandboxRoutes path={path} />));
  await wait();
}
const wait = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const button = (text: string) => [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text))!;
const radio = (text: string) =>
  [...document.body.querySelectorAll('label')].find((label) => label.textContent?.trim() === text)!.querySelector('input')!;
async function type(selector: string, value: string) {
  const element = document.body.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (element: HTMLElement) => act(async () => void element.click());

describe('sandboxRoute', () => {
  it('reads the list, one sandbox, its key form, the test values, and nothing else', () => {
    expect(sandboxRoute('/developers/sandbox/')).toEqual({ kind: 'list' });
    expect(sandboxRoute(`/developers/sandbox/${SANDBOX.toUpperCase()}?x=1`)).toEqual({ kind: 'sandbox', id: SANDBOX });
    expect(sandboxRoute(`/developers/sandbox/${SANDBOX}/keys/new`)).toEqual({ kind: 'new-key', id: SANDBOX });
    expect(sandboxRoute('/developers/sandbox/test-values')).toEqual({ kind: 'test-values' });
    expect(sandboxRoute('/developers/sandbox/test-values/x')).toEqual({ kind: 'unknown' });
    expect(sandboxRoute(`/developers/sandbox/${SANDBOX}/keys`)).toEqual({ kind: 'unknown' });
  });
});

describe('sandbox rooms', () => {
  it('asks a signed-out visitor to sign in and reads nothing', async () => {
    world.userId = null;
    world.list = vi.fn();
    await show('/developers/sandbox');
    expect(document.body.textContent).toContain('Sign in to use the sandbox');
    expect(world.list).not.toHaveBeenCalled();
  });

  it('lists sandboxes with the unset cap and the sandbox address', async () => {
    await show('/developers/sandbox');
    expect(document.querySelector(`a[href="/developers/sandbox/${SANDBOX}"]`)?.textContent).toBe('development');
    expect(document.querySelector('[data-testid="sandbox-cap"]')?.getAttribute('data-limit')).toBe('unset');
    expect(document.querySelector('[data-testid="sandbox-base-url"]')?.textContent).toBe('http://sandbox.test');
  });

  it('shows a refused create with its code kept on the alert', async () => {
    world.create = async () => ({ ok: false, code: 'identity.sandbox_cap_unset', message: 'refused' });
    await show('/developers/sandbox');
    await type('input', 'ci');
    await click(button('Create sandbox'));
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-code')).toBe('identity.sandbox_cap_unset');
    expect(alert.textContent).toContain('no second sandbox was made');
  });

  it('says so when the sandbox address is not set', async () => {
    world.get = async () => ({ ok: true, data: { sandbox: record, keys: [], baseUrl: null } });
    await show(`/developers/sandbox/${SANDBOX}`);
    expect(document.querySelector('h1')?.textContent).toBe('development');
    expect(document.querySelector('[data-testid="sandbox-base-url-unset"]')).not.toBeNull();
  });

  it('reads each key as active, revoked or past its end date', async () => {
    const keys = [
      { ...keyRecord, id: '5d1f7b7e-1c2a-4f0e-8d5c-2b3c4d5e6f71', name: 'live-one' },
      { ...keyRecord, id: '5d1f7b7e-1c2a-4f0e-8d5c-2b3c4d5e6f72', name: 'gone', revoked: true },
      { ...keyRecord, id: '5d1f7b7e-1c2a-4f0e-8d5c-2b3c4d5e6f73', name: 'old', expiresAt: '2026-01-01T00:00:00.000Z' },
    ];
    world.get = async () => ({ ok: true, data: { sandbox: record, keys, baseUrl: 'http://sandbox.test' } });
    await show(`/developers/sandbox/${SANDBOX}`);
    const state = (id: string) => document.querySelector(`tr[data-key-id="${id}"] td:last-child`)?.textContent;
    expect(state(keys[0]!.id)).toBe('Active');
    expect(state(keys[1]!.id)).toBe('Revoked');
    expect(state(keys[2]!.id)).toBe('Expired');
  });

  it('keeps the heading and the way back when the sandbox cannot be read', async () => {
    world.get = async () => ({ ok: false, code: 'edge.upstream_unwired', message: 'refused' });
    await show(`/developers/sandbox/${SANDBOX}`);
    expect(document.querySelector('h1')?.textContent).toBe('Sandbox');
    expect(document.querySelector('a[href="/developers/sandbox"]')?.textContent).toContain('All sandboxes');
  });

  it('shows the TEST balance with the owner settings not set, and Fund and Reset refuse by name', async () => {
    world.fund = vi.fn(async () => ({ ok: false, code: 'pay.sandbox_funds_unset', message: 'refused' }));
    world.reset = vi.fn(async () => ({ ok: false, code: 'pay.sandbox_reset_cap_unset', message: 'refused' }));
    await show(`/developers/sandbox/${SANDBOX}`);
    const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect(text('sandbox-balance')).toBe('0 USDT TEST');
    expect(text('sandbox-fund-amount')).toBe('not set');
    expect(text('sandbox-resets')).toBe('not set');
    await click(button('Fund with TEST money'));
    expect(world.fund).toHaveBeenCalledWith(unsetBalance);
    const alert = () => document.querySelector('[role="alert"]')!;
    expect(alert().getAttribute('data-code')).toBe('pay.sandbox_funds_unset');
    expect(alert().textContent).toContain('The owner has not set sandbox test funds. Nothing was added.');
    expect(text('sandbox-balance')).toBe('0 USDT TEST');
    await click(button('Reset balances'));
    expect(alert().getAttribute('data-code')).toBe('pay.sandbox_reset_cap_unset');
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('adds the TEST amount on Fund, sends the version it read, and says so; a spent reset cap refuses by name', async () => {
    const set = { ...unsetBalance, fundAmount: '1000', resetsPerDay: 2, resetsToday: 1, version: 3 };
    world.balance = async () => ({ ok: true, data: set });
    world.fund = vi.fn(async () => ({ ok: true, data: { ...set, amount: '1000', version: 4, replayed: false } }));
    world.reset = vi.fn(async () => ({ ok: false, code: 'pay.sandbox_reset_cap_reached', message: 'refused' }));
    await show(`/developers/sandbox/${SANDBOX}`);
    const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect(text('sandbox-fund-amount')).toBe('1000 USDT TEST');
    expect(text('sandbox-resets')).toBe('1 of 2');
    await click(button('Fund with TEST money'));
    expect(world.fund).toHaveBeenCalledWith(set);
    expect(text('sandbox-balance')).toBe('1000 USDT TEST');
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Added 1000 USDT (TEST) to this sandbox.');
    await click(button('Reset balances'));
    expect(world.reset).toHaveBeenCalledWith({ ...set, amount: '1000', version: 4 });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('daily reset limit');
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('lists the card test values from the contract, with the decline token and its failure code', async () => {
    await show('/developers/sandbox/test-values');
    expect(document.querySelector('h1')?.textContent).toBe('Sandbox test values');
    const table = document.querySelector('[role="region"][aria-label="Test values"] table')!;
    const row = (id: string) => table.querySelector(`tr[data-test-value="${id}"]`)!;
    expect(row('decline').querySelector('th')?.textContent).toBe('Decline');
    expect([...row('decline').querySelectorAll('code')].map((c) => c.textContent)).toEqual(['tok_decline', 'card.declined']);
    expect(row('acquirer_outage').querySelector('code')?.textContent).toBe('tok_rail_error');
    expect(row('funds_held').querySelector('code')?.textContent).toBe('tok_funds_held');
    expect(row('approve').textContent).toContain('Any other token');
  });

  it('sends the trade preset as asked and shows the sandbox refusal by code', async () => {
    world.createKey = vi.fn(async () => ({ ok: false, code: 'env.scope_not_sandboxable', message: 'refused' }));
    await show(`/developers/sandbox/${SANDBOX}/keys/new`);
    await type('input[type="text"], input:not([type])', 'trade-bot');
    await click(radio('Trade'));
    await click(button('Create with a passkey'));
    expect(world.createKey).toHaveBeenCalledWith({ name: 'trade-bot', scopes: ['trade:read', 'trade:write'] });
    expect(document.querySelector('[role="alert"]')?.getAttribute('data-code')).toBe('env.scope_not_sandboxable');
    expect(document.querySelector('[data-testid="api-keys__key"]')).toBeNull();
  });

  it('shows a made key once with the base URL, and Done waits for the stored tick', async () => {
    world.createKey = async () => ({
      ok: true,
      data: { record: keyRecord, key: 'ifc_test_secret', replayed: false, baseUrl: 'http://sandbox.test' },
    });
    await show(`/developers/sandbox/${SANDBOX}/keys/new`);
    await type('input:not([type])', 'bot');
    await click(radio('Read only'));
    await click(button('Create with a passkey'));
    expect(document.querySelector('[data-testid="api-keys__key"]')?.textContent).toBe('ifc_test_secret');
    expect(document.querySelector('[data-testid="sandbox-base-url"]')?.textContent).toBe('http://sandbox.test');
    expect(button('Done').disabled).toBe(true);
    await click([...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]!);
    expect(button('Done').disabled).toBe(false);
  });

  it('answers a repeated request without showing any key', async () => {
    world.createKey = async () => ({ ok: true, data: { record: keyRecord, key: null, replayed: true, baseUrl: 'http://sandbox.test' } });
    await show(`/developers/sandbox/${SANDBOX}/keys/new`);
    await type('input:not([type])', 'bot');
    await click(button('Create with a passkey'));
    expect(document.querySelector('[role="status"]')?.textContent).toContain('none is shown now');
    expect(document.querySelector('[data-testid="api-keys__key"]')).toBeNull();
  });
});
