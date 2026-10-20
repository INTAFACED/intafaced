// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const world = vi.hoisted(() => ({
  userId: 'u1' as string | null,
  preview: undefined as unknown as (request: unknown) => Promise<unknown>,
  decide: undefined as unknown as (request: unknown, decision: string) => Promise<unknown>,
}));
vi.mock('../session/session', () => ({ useSession: () => ({ userId: world.userId, api: {} }) }));
vi.mock('../developers/apps/oauth-api', async (original) => {
  const real = await original<typeof import('../developers/apps/oauth-api')>();
  return {
    ...real,
    previewAuthorize: (_api: unknown, request: unknown) => world.preview(request),
    decideAuthorize: (_api: unknown, request: unknown, decision: string) => world.decide(request, decision),
  };
});

import { OAuthConsent } from './OAuthConsent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const GOOD =
  '?response_type=code&client_id=ifc_abc&redirect_uri=https%3A%2F%2Fapp.example.test%2Fcb&scope=trade%3Aread+academy%3Aread&state=s1' +
  `&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
const assign = vi.fn();
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = 'u1';
  assign.mockReset();
  vi.stubGlobal('location', { search: GOOD, pathname: '/oauth/authorize', assign });
  world.preview = async () => ({
    ok: true,
    data: {
      appName: 'Ledger sync',
      appDescription: 'Keeps your ledger in step',
      logoUrl: null,
      developerOwnAccount: false,
      scopes: ['trade:read', 'academy:read'],
    },
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function show() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<OAuthConsent />));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
const button = (text: string) => [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
const click = (text: string) => act(async () => void button(text)!.click());

describe('authorise page', () => {
  it('refuses a request with no state on the page: no calls, no redirect', async () => {
    vi.stubGlobal('location', { search: GOOD.replace('&state=s1', ''), pathname: '/oauth/authorize', assign });
    const preview = vi.fn(world.preview);
    world.preview = preview;
    await show();
    expect(host.textContent).toContain('This request is not valid');
    expect(host.textContent).toContain('The request has no state value.');
    expect(preview).not.toHaveBeenCalled();
    expect(button('Allow')).toBeUndefined();
  });

  it('sends a signed-out person to sign in and back to the same request', async () => {
    world.userId = null;
    await show();
    const link = host.querySelector('a[href^="/login"]') as HTMLAnchorElement;
    expect(decodeURIComponent(link.getAttribute('href')!)).toContain('/oauth/authorize' + GOOD);
  });

  it('shows the app and each permission in plain words, naming a scope with no words as it is', async () => {
    await show();
    expect(host.textContent).toContain('Allow Ledger sync to use your account?');
    expect(host.textContent).toContain('See your orders, trades and positions');
    expect(host.textContent).toContain('academy:read');
    expect(host.textContent).toContain('No description was written for this permission.');
    expect(host.textContent).not.toContain('This is your own app');
  });

  it("says so when it is the developer's own app waiting for approval", async () => {
    world.preview = async () => ({
      ok: true,
      data: { appName: 'Mine', appDescription: null, logoUrl: null, developerOwnAccount: true, scopes: ['trade:read'] },
    });
    await show();
    expect(host.textContent).toContain('This is your own app, waiting for approval.');
  });

  it('allows once, however often it is pressed, and follows the returned https address', async () => {
    const decide = vi.fn(async (_request: unknown, _decision: string) => ({
      ok: true,
      data: { redirectTo: 'https://app.example.test/cb?code=ifcc_x&state=s1' },
    }));
    world.decide = decide;
    await show();
    await act(async () => {
      // Two presses in the same moment: the second finds the first still in flight.
      button('Allow')!.click();
      button('Allow')!.click();
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]).toMatchObject([{ clientId: 'ifc_abc', state: 's1', codeChallengeMethod: 'S256' }, 'allow']);
    expect(assign).toHaveBeenCalledWith('https://app.example.test/cb?code=ifcc_x&state=s1');
  });

  it('denies through the service too', async () => {
    const decide = vi.fn(async (_request: unknown, _decision: string) => ({
      ok: true,
      data: { redirectTo: 'https://app.example.test/cb?error=access_denied&state=s1' },
    }));
    world.decide = decide;
    await show();
    await click('Deny');
    expect(decide.mock.calls[0]?.[1]).toBe('deny');
    expect(assign).toHaveBeenCalledWith('https://app.example.test/cb?error=access_denied&state=s1');
  });

  it('does not follow an address that is not https', async () => {
    world.decide = async () => ({ ok: true, data: { redirectTo: 'http://app.example.test/cb?code=x' } });
    await show();
    await click('Allow');
    expect(assign).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Nothing was shared.');
  });

  it('shows a service refusal in words and does not leave the page', async () => {
    world.decide = async () => ({ ok: false, reason: 'error', message: 'x', code: 'oauth.account_not_active', status: 412 });
    await show();
    await click('Allow');
    expect(host.textContent).toContain('This account cannot register apps right now.');
    expect(assign).not.toHaveBeenCalled();
    expect(button('Allow')).toBeDefined();
  });

  it('refuses at the preview when the app is not approved for this account', async () => {
    world.preview = async () => ({ ok: false, reason: 'error', message: 'x', code: 'oauth.app_not_approved', status: 412 });
    await show();
    expect(host.textContent).toContain('This request cannot be answered.');
    expect(host.textContent).toContain('oauth.app_not_approved');
    expect(button('Allow')).toBeUndefined();
  });
});
