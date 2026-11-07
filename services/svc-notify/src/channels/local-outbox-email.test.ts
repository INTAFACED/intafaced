import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChannelRefusal, type OutboundMessage } from './channel.js';
import { LocalOutboxEmailChannel, localOutboxEmailPurpose, openLocalOutboxEmail } from './local-outbox-email.js';
import { channelsFromEnv } from './registry.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'notify-outbox-')), 'email-outbox.log');

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    notificationId: '55555555-5555-4555-8555-555555555555',
    userId: 'u-1',
    channel: 'email',
    kind: 'promo.test',
    severity: 'info',
    titleKey: 'notify.promo.test.title',
    bodyKey: 'notify.promo.test.body',
    title: 'TEST promotion',
    body: 'Body words that must not reach the line.',
    href: null,
    locale: 'en',
    address: 'pfn@local-test.invalid',
    idempotencyKey: '55555555-5555-4555-8555-555555555555:email',
    ...overrides,
  };
}

describe('the LOCAL TEST email outbox', () => {
  it('opens only for local-outbox, APP_ENV exactly dev or test, no gateway and an absolute path', () => {
    const ok = { appEnv: 'test', transport: 'local-outbox', outboxPath: file(), gatewayConfigured: false };
    expect(openLocalOutboxEmail({ ...ok, transport: undefined })).toBeNull();
    expect(openLocalOutboxEmail({ ...ok, transport: '  ' })).toBeNull();
    expect(openLocalOutboxEmail(ok)).toBeInstanceOf(LocalOutboxEmailChannel);
    expect(openLocalOutboxEmail({ ...ok, appEnv: 'dev' })).toBeInstanceOf(LocalOutboxEmailChannel);
    for (const appEnv of [undefined, '', 'staging', 'prod', 'DEV'])
      expect(() => openLocalOutboxEmail({ ...ok, appEnv }), String(appEnv)).toThrow(/notify.email_transport_refused/);
    expect(() => openLocalOutboxEmail({ ...ok, transport: 'smtp' })).toThrow(/unknown transport/);
    expect(() => openLocalOutboxEmail({ ...ok, gatewayConfigured: true })).toThrow(/gateway/);
    expect(() => openLocalOutboxEmail({ ...ok, outboxPath: 'relative.log' })).toThrow(/absolute/);
    expect(() => openLocalOutboxEmail({ ...ok, outboxPath: undefined })).toThrow(/absolute/);
  });

  it('writes one LOCAL-TEST line per email that the journey reader matches, without the rendered body', async () => {
    const outbox = file();
    const channel = new LocalOutboxEmailChannel(outbox, () => new Date('2026-11-07T00:00:00.000Z'));
    await expect(channel.deliver(message())).resolves.toEqual({ reference: null });
    await channel.deliver(message({ kind: 'trade.fill.settled', address: 'other@local-test.invalid' }));
    const lines = readFileSync(outbox, 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual([
      'LOCAL-TEST purpose=promotion email=pfn@local-test.invalid kind=promo.test notification=55555555-5555-4555-8555-555555555555 at=2026-11-07T00:00:00.000Z',
      'LOCAL-TEST purpose=notify-trade-fill-settled email=other@local-test.invalid kind=trade.fill.settled notification=55555555-5555-4555-8555-555555555555 at=2026-11-07T00:00:00.000Z',
    ]);
    // The reader in apps/customer/tests/real-app/stack.mjs (mailedLines) matches on these two fields.
    expect(lines.filter((l) => l.includes('purpose=promotion ') && l.includes(' email=pfn@local-test.invalid '))).toHaveLength(1);
    expect(readFileSync(outbox, 'utf8')).not.toContain('Body words');
  });

  it('refuses an address no mailbox can be, and writes nothing', async () => {
    const outbox = file();
    const channel = new LocalOutboxEmailChannel(outbox);
    await expect(channel.deliver(message({ address: 'not an address' }))).rejects.toBeInstanceOf(ChannelRefusal);
    expect(existsSync(outbox)).toBe(false);
  });

  it('names a promotion `promotion` and anything else notify-<kind>', () => {
    expect(localOutboxEmailPurpose('promo.test')).toBe('promotion');
    expect(localOutboxEmailPurpose('promo.weekly')).toBe('promotion');
    expect(localOutboxEmailPurpose('promotional.x')).toBe('notify-promotional-x');
    expect(localOutboxEmailPurpose('support.rate_request')).toBe('notify-support-rate-request');
  });

  it('in the registry, email reads configured with it and stays not configured without it', () => {
    const base = { NOTIFY_GATEWAY_TIMEOUT_MS: 5_000 };
    const wired = channelsFromEnv({ ...base, NOTIFY_EMAIL_TRANSPORT: 'local-outbox', NOTIFY_EMAIL_OUTBOX: file() }, fetch, 'test');
    expect(wired.get('email')).toBeInstanceOf(LocalOutboxEmailChannel);
    expect(wired.status().find((s) => s.channel === 'email')).toMatchObject({ configured: true });
    expect(wired.status().find((s) => s.channel === 'sms')).toMatchObject({ configured: false, reason: 'channel.not_configured' });

    const blank = channelsFromEnv(base, fetch, 'test');
    expect(blank.status().find((s) => s.channel === 'email')).toMatchObject({ configured: false, reason: 'channel.not_configured' });
    expect(() =>
      channelsFromEnv({ ...base, NOTIFY_EMAIL_TRANSPORT: 'local-outbox', NOTIFY_EMAIL_OUTBOX: file() }, fetch, undefined),
    ).toThrow(/APP_ENV/);
    expect(() =>
      channelsFromEnv(
        {
          ...base,
          NOTIFY_EMAIL_TRANSPORT: 'local-outbox',
          NOTIFY_EMAIL_OUTBOX: file(),
          NOTIFY_EMAIL_GATEWAY_URL: 'https://mail.example.test',
          NOTIFY_EMAIL_GATEWAY_TOKEN: 't',
        },
        fetch,
        'test',
      ),
    ).toThrow(/gateway/);
  });
});
