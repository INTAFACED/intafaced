// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const world = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  list: undefined as unknown as () => Promise<unknown>,
  register: undefined as unknown as (fields: unknown) => Promise<unknown>,
  roll: undefined as unknown as (app: unknown) => Promise<unknown>,
  lifetimes: undefined as unknown as () => Promise<unknown>,
}));
vi.mock('../../session/session', () => ({ useSession: () => ({ userId: world.userId, api: {} }) }));
vi.mock('./oauth-api', async (original) => {
  const real = await original<typeof import('./oauth-api')>();
  return {
    ...real,
    readApps: () => world.list(),
    registerApp: (_api: unknown, _user: string, fields: unknown) => world.register(fields),
    rollSecret: (_api: unknown, app: unknown) => world.roll(app),
    readLifetimes: () => world.lifetimes(),
  };
});

import { AppsRoom } from './AppsRoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = 'u1';
  world.list = async () => ({ ok: true, data: { apps: [] } });
  world.lifetimes = async () => ({ ok: true, data: { codeTtlSeconds: 60, accessTokenTtlSeconds: 3600 } });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});
async function show() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<AppsRoom />));
}
const wait = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const button = (text: string) => [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
async function type(selector: string, value: string) {
  const element = document.body.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function fill(over: { redirects?: string; scopes?: string } = {}) {
  await type('.apps-form label:nth-of-type(1) input', 'Ledger sync');
  await type('.apps-form label:nth-of-type(3) textarea', over.redirects ?? 'https://app.example.test/cb');
  await type('.apps-form label:nth-of-type(4) textarea', over.scopes ?? 'trade:read');
}
const submit = () =>
  act(async () => void document.body.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

const app = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  clientId: 'ifc_abc',
  name: 'Ledger sync',
  description: null,
  logoUrl: null,
  redirectUrls: ['https://app.example.test/cb'],
  scopes: ['trade:read'],
  confidential: true,
  status: 'pending',
  createdAt: '2026-10-20T12:00:00.000Z',
  secretRolledAt: null,
  ...over,
});

describe('registered apps room', () => {
  it('sends a signed-out visitor to sign in and reads nothing', async () => {
    world.userId = null;
    const read = vi.fn(world.list);
    world.list = read;
    await show();
    expect(host.textContent).toContain('Sign in to register an app');
    expect(host.querySelector('a[href^="/login"]')).not.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('says plainly when there are no apps, and keeps the form visible', async () => {
    await show();
    await wait();
    expect(host.textContent).toContain('You have not registered an app.');
    expect(host.querySelector('form')).not.toBeNull();
  });

  it('lists an app with its status in words and offers a secret change only for a server app', async () => {
    world.list = async () => ({
      ok: true,
      data: {
        apps: [
          app(),
          app({ id: '22222222-2222-4222-8222-222222222222', clientId: 'ifc_pub', name: 'Phone', confidential: false, status: 'approved' }),
        ],
      },
    });
    await show();
    await wait();
    expect(host.textContent).toContain('Waiting for approval. Only your own account can authorise it.');
    expect(host.textContent).toContain('Approved. Any account can authorise it.');
    expect(host.querySelectorAll('[data-testid^="app-"] button')).toHaveLength(1);
  });

  it('refuses a bad redirect address on the page and sends nothing', async () => {
    const register = vi.fn();
    world.register = register;
    await show();
    await wait();
    await fill({ redirects: 'http://app.example.test/cb' });
    await submit();
    expect(host.textContent).toContain('http://app.example.test/cb is not an exact https address.');
    expect(register).not.toHaveBeenCalled();
  });

  it('registers once, shows the secret once, and reads the list again', async () => {
    const register = vi.fn(async () => ({ ok: true, data: { app: app(), clientSecret: 'ifcs_TESTSECRET' } }));
    world.register = register;
    const read = vi.fn(world.list);
    world.list = read;
    await show();
    await wait();
    await fill({ scopes: 'trade:read, identity:read' });
    await submit();
    await wait();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith({
      name: 'Ledger sync',
      redirectUrls: ['https://app.example.test/cb'],
      scopes: ['trade:read', 'identity:read'],
      confidential: true,
    });
    expect(host.querySelector('[data-testid="client-secret"]')?.textContent).toBe('ifcs_TESTSECRET');
    expect(host.textContent).toContain('only time the secret is shown');
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => void button('I have saved it')!.click());
    expect(host.querySelector('[data-testid="client-secret"]')).toBeNull();
  });

  it('shows the service refusal in words with its code', async () => {
    world.register = async () => ({ ok: false, reason: 'error', message: 'x', code: 'oauth.scope_not_delegable', status: 412 });
    await show();
    await wait();
    await fill({ scopes: 'trade:withdraw' });
    await submit();
    await wait();
    expect(host.textContent).toContain('A scope that needs an interactive session cannot be declared by an app.');
    expect(host.querySelector('code')?.textContent).toBeTruthy();
    expect(host.textContent).toContain('oauth.scope_not_delegable');
  });

  it('changes the secret and shows the new one once; a repeat shows none', async () => {
    world.list = async () => ({ ok: true, data: { apps: [app()] } });
    world.roll = vi.fn(async () => ({
      ok: true,
      data: { app: app({ secretRolledAt: '2026-10-20T13:00:00.000Z' }), clientSecret: 'ifcs_NEWSECRET' },
    }));
    await show();
    await wait();
    await act(async () => void button('Change client secret')!.click());
    await wait();
    expect(host.querySelector('[data-testid="client-secret"]')?.textContent).toBe('ifcs_NEWSECRET');
    await act(async () => void button('I have saved it')!.click());
    world.roll = async () => ({ ok: true, data: { app: app(), clientSecret: null } });
    await act(async () => void button('Change client secret')!.click());
    await wait();
    expect(host.querySelector('[data-testid="client-secret"]')).toBeNull();
    expect(host.textContent).toContain('already registered');
  });

  it('keeps the list failure visible with a retry', async () => {
    world.list = async () => ({ ok: false, reason: 'unreachable', message: 'down', status: 503 });
    await show();
    await wait();
    expect(host.textContent).toContain('Your apps could not be read.');
  });
});

describe('the owner lifetimes blocker (oauth.lifetime_unset)', () => {
  const unset = () => document.body.querySelector('[data-code="oauth.lifetime_unset"]');

  it('names the blocker up front when a lifetime is unpublished', async () => {
    world.lifetimes = async () => ({ ok: true, data: { codeTtlSeconds: null, accessTokenTtlSeconds: 3600 } });
    await show();
    await wait();
    expect(unset()?.textContent).toBe(
      'The owner has not published the lifetime that signing in with apps needs, so apps are switched off.',
    );
  });

  it('says nothing when both lifetimes are published, or while the read has not answered', async () => {
    await show();
    await wait();
    expect(unset()).toBeNull();
    act(() => root?.unmount());
    root = null;
    world.lifetimes = () => new Promise(() => undefined);
    await show();
    expect(unset()).toBeNull();
  });

  it('says the read failed, with a retry, rather than hiding the blocker when the lifetimes cannot be read', async () => {
    world.lifetimes = async () => ({ ok: false, reason: 'unreachable', message: 'down', status: 503 });
    await show();
    await wait();
    expect(unset()).toBeNull();
    expect(document.body.textContent).toContain('Whether apps can sign people in could not be read.');
  });
});
