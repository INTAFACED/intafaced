// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { AlertDelivery, channelBlock, deliveryIntent, NO_DELIVERY_CHOICE, webhookProblem, type DeliveryChoice } from './AlertDelivery';
import { TriggerLog } from './TriggerLog';
import type { ChannelRow } from './notify-api';

/** J-charts-desk-10: the per-alert channel choice and what each firing did, as the page shows them. */

const offRows: ChannelRow[] = [
  { channel: 'inapp', configured: true, available: true },
  { channel: 'email', configured: false, available: false, reason: 'channel.not_configured' } as ChannelRow,
  { channel: 'push', configured: false, available: false, reason: 'channel.not_configured' } as ChannelRow,
];

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the delivery choice', () => {
  it('a ticked email or push with no sender names the dependency beside it; the webhook rule is published', () => {
    const value: DeliveryChoice = { email: true, push: true, webhookUrl: '' };
    act(() =>
      root.render(
        <AlertDelivery
          value={value}
          onChange={() => undefined}
          disabled={false}
          facts={{
            channels: { status: 'ready', value: offRows },
            policy: { status: 'ready', value: { ports: [443], retrySeconds: [5, 5, 5], timeoutMs: 5000 } },
          }}
        />,
      ),
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Email needs an email delivery service. It is switched off in this build.');
    expect(text).toContain('Push needs a push delivery service. It is switched off in this build.');
    expect(host.querySelector('[data-not-connected="vendor.email"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="alerts-webhook-policy"]')?.textContent).toBe(
      'A webhook may use port 443. If your endpoint answers with a 5xx error other than 504, or cannot be reached, it is sent again after 5, 5 and 5 seconds. Any other answer is not sent again.',
    );
  });

  it('webhooks switched off: the field is closed and the reason is shown', () => {
    act(() =>
      root.render(
        <AlertDelivery
          value={NO_DELIVERY_CHOICE}
          onChange={() => undefined}
          disabled={false}
          facts={{
            channels: { status: 'ready', value: offRows },
            policy: { status: 'ready', value: { ports: null, retrySeconds: null, timeoutMs: 5000 } },
          }}
        />,
      ),
    );
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.disabled).toBe(true);
    expect(host.textContent).toContain('Webhooks are switched off: the platform has not set which ports they may use.');
  });

  it('helpers: blocks from the service status, the intent sends only ticked channels', () => {
    expect(channelBlock({ status: 'ready', value: offRows }, 'email')).toBe('off');
    expect(channelBlock({ status: 'ready', value: [{ channel: 'email', configured: true, available: false }] }, 'email')).toBeNull();
    expect(channelBlock({ status: 'failed' }, 'push')).toBe('unknown');
    expect(deliveryIntent({ email: true, push: false, webhookUrl: '  https://h.example/x ' })).toEqual({
      channels: ['email'],
      webhookUrl: 'https://h.example/x',
    });
    expect(deliveryIntent(NO_DELIVERY_CHOICE)).toEqual({ channels: [] });
    expect(webhookProblem('not a url')).toBe('invalid');
    expect(webhookProblem('ftp://h.example/')).toBe('invalid');
    expect(webhookProblem('')).toBeNull();
  });
});

describe('the trigger history shows where each firing went', () => {
  it('in-app written, email not sent with its reason, never "handed"; webhook attempts with status and cause', () => {
    const page = {
      retentionDays: 7,
      items: [
        {
          alertId: '11111111-1111-4111-8111-111111111111',
          seq: 1,
          marketId: 'm1',
          condition: 'greater_than' as const,
          targetPrice: '100',
          markPrice: '101',
          firedAt: '2026-11-14T04:00:00.000Z',
          notificationId: '22222222-2222-4222-8222-222222222222',
          deliveries: [
            {
              channel: 'email' as const,
              status: 'refused' as const,
              attempts: 0,
              attemptedAt: null,
              acceptedAt: null,
              refusalCode: 'channel.not_configured',
            },
            {
              channel: 'inapp' as const,
              status: 'accepted' as const,
              attempts: 1,
              attemptedAt: '2026-11-14T04:00:00.000Z',
              acceptedAt: '2026-11-14T04:00:00.000Z',
              refusalCode: null,
            },
          ],
          webhook: {
            status: 'failed' as const,
            nextAttemptAt: null,
            attempts: [
              { n: 1, at: '2026-11-14T04:00:00.000Z', status: 503, cause: 'unavailable' as const, durationMs: 3 },
              { n: 2, at: '2026-11-14T04:00:05.000Z', status: 503, cause: 'unavailable' as const, durationMs: 3 },
            ],
          },
        },
      ],
    };
    act(() => root.render(<TriggerLog state={{ status: 'ready', page }} onRetry={() => undefined} marketLabel={() => 'BTC/USDT'} />));
    const channels = [...host.querySelectorAll('[data-testid="alert-trigger-channel"]')].map((li) => li.getAttribute('data-channel'));
    expect(channels).toEqual(['inapp', 'email']);
    const email = host.querySelector('[data-channel="email"]')!.textContent ?? '';
    expect(email).toContain('Email: not sent.');
    expect(email).toContain('Email needs an email delivery service. It is switched off in this build.');
    expect(email).not.toContain('handed');
    expect(host.querySelector('[data-testid="alert-webhook-state"]')?.textContent).toBe('Webhook: not delivered after 2 attempts.');
    const attempts = [...host.querySelectorAll('[data-testid="alert-webhook-attempt"]')];
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.textContent).toContain('Attempt 2');
    expect(attempts[1]!.textContent).toContain('HTTP 503');
    expect(attempts[1]!.textContent).toContain('could not take it right now (a 5xx error)');
  });
});
