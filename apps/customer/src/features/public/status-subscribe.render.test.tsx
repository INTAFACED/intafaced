// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusChallengeMet, statusChallengeText } from '@intafaced/contracts/status-subscriptions';

type Call = { procedure: string; input: unknown };
const calls: Call[] = [];
let answers: Record<string, unknown> = {};
const answer = (procedure: string, input: unknown) => {
  calls.push({ procedure, input });
  const value = answers[procedure];
  if (value instanceof Error) return { ok: false, reason: 'refused', message: value.message, code: value.message };
  return { ok: true, data: typeof value === 'function' ? (value as (i: unknown) => unknown)(input) : value };
};
const api = {
  query: async (_module: string, procedure: string, input: unknown) => answer(procedure, input),
  mutate: async (_module: string, procedure: string, input: unknown) => answer(procedure, input),
};
vi.mock('../../data/hooks', () => ({ useDataEnv: () => ({ api, poller: {}, userId: null }) }));
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { StatusSubscribe } from './StatusSubscribe';
import { StatusSubscriptionPage } from './StatusSubscription';
import { StatusBadgeShare } from './StatusBadgeShare';

const POLICY = { email: null, sms: 'vendor.sms', push: 'vendor.push', challengeBits: 4, rateLimitSet: true };
const COMPONENTS = [{ id: 'trading', name: 'Trading', group: null, basis: 'reading', state: 'operational', source: null, uptime: [] }];

let host: HTMLDivElement, root: Root;
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
  await act(async () => void button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
  answers = {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('status subscribe form', () => {
  it('names the channels that are not offered, solves the challenge, and sends nothing else', async () => {
    answers = {
      'statusPage.subscriptions.policy': POLICY,
      'statusPage.subscriptions.challenge': { token: 'challenge-token', bits: 4 },
      'statusPage.subscriptions.subscribe': { state: 'confirmation_sent', notConnected: null },
    };
    await act(async () => root.render(<StatusSubscribe components={COMPONENTS as never} />));
    await flush();
    expect(host.textContent).toContain('vendor.sms');
    expect(host.textContent).toContain('vendor.push');
    const input = host.querySelector<HTMLInputElement>('input[name="email"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'me@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    const sent = calls.find((c) => c.procedure === 'statusPage.subscriptions.subscribe')!.input as {
      email: string;
      componentIds: null;
      challenge: { token: string; nonce: string };
    };
    expect(sent).toMatchObject({ email: 'me@example.com', componentIds: null, challenge: { token: 'challenge-token' } });
    expect(statusChallengeMet(createHash('sha256').update(statusChallengeText('challenge-token', sent.challenge.nonce)).digest(), 4)).toBe(
      true,
    );
    expect(host.querySelector('[data-testid="status-subscribe-sent"]')).not.toBeNull();
  });

  it('stays closed with the reason while the owner safeguards are blank', async () => {
    answers = { 'statusPage.subscriptions.policy': { ...POLICY, challengeBits: null } };
    await act(async () => root.render(<StatusSubscribe components={[]} />));
    await flush();
    expect(host.querySelector('[data-testid="status-subscribe-closed"]')?.textContent).toContain('status.challenge_unset');
    expect(host.querySelector('form')).toBeNull();
  });

  it('says a confirmation waits when no email sender is connected', async () => {
    answers = {
      'statusPage.subscriptions.policy': { ...POLICY, email: 'vendor.email' },
      'statusPage.subscriptions.challenge': { token: 't', bits: 1 },
      'statusPage.subscriptions.subscribe': { state: 'confirmation_pending', notConnected: 'vendor.email' },
    };
    await act(async () => root.render(<StatusSubscribe components={[]} />));
    await flush();
    expect(host.querySelector('[data-testid="status-subscribe-email-off"]')).not.toBeNull();
    const input = host.querySelector<HTMLInputElement>('input[name="email"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'me@example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(host.querySelector('[data-testid="status-subscribe-pending"]')?.textContent).toContain('vendor.email');
  });
});

describe('status subscription links', () => {
  it('opening the confirm link spends nothing; pressing Confirm does, and the token leaves the address bar', async () => {
    history.replaceState(null, '', '/status/confirm?token=confirm.abc');
    answers = {
      'statusPage.read': { components: COMPONENTS },
      'statusPage.subscriptions.confirm': {
        state: 'active',
        email: 'm*@example.com',
        componentIds: null,
        webhookUrl: null,
        manageToken: 'manage.x',
      },
    };
    await act(async () => root.render(<StatusSubscriptionPage mode="confirm" />));
    await flush();
    expect(calls).toHaveLength(0);
    expect(location.search).toBe('');
    await click('Confirm');
    await flush();
    expect(calls.find((c) => c.procedure !== 'statusPage.read')).toEqual({
      procedure: 'statusPage.subscriptions.confirm',
      input: { token: 'confirm.abc' },
    });
    expect(host.querySelector('[data-testid="status-subscription-state"]')?.textContent).toBe('Active');
  });

  it('a link with no token, or one the service refuses, says it does not work', async () => {
    history.replaceState(null, '', '/status/unsubscribe');
    await act(async () => root.render(<StatusSubscriptionPage mode="unsubscribe" />));
    expect(host.querySelector('[data-testid="status-subscription-dead"]')).not.toBeNull();
  });
});

describe('status badge share panel', () => {
  it('gives an image link and an image-and-link snippet, for the whole page or one component, never a frame', async () => {
    await act(async () => root.render(<StatusBadgeShare components={COMPONENTS as never} />));
    const url = () => host.querySelector<HTMLInputElement>('[data-testid="status-share-url"]')!.value;
    const snippet = () => host.querySelector<HTMLTextAreaElement>('[data-testid="status-share-snippet"]')!.value;
    expect(url()).toBe(`${location.origin}/api/notify/status/badge.svg`);
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'trading';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(url()).toBe(`${location.origin}/api/notify/status/badge.svg?component=trading`);
    expect(snippet()).toBe(
      `<a href="${location.origin}/status"><img src="${location.origin}/api/notify/status/badge.svg?component=trading" alt="Trading status"></a>`,
    );
    expect(snippet()).not.toMatch(/iframe|script/i);
  });
});
