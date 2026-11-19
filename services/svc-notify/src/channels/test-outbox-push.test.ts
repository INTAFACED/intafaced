import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { channelsFromEnv } from './registry.js';
import { TestOutboxPushChannel, testPushOutbox } from './test-outbox.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const outboxFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notify-push-outbox-'));
  dirs.push(dir);
  return path.join(dir, 'push-outbox.log');
};

describe('the TEST push stand-in (J-home-ia-05 #4)', () => {
  it('is allowed only on a dev or test stack, and only as an absolute path; blank is none', () => {
    expect(testPushOutbox(undefined, 'test')).toBeNull();
    expect(testPushOutbox('  ', 'prod')).toBeNull();
    expect(testPushOutbox('/x/push.log', 'test')).toBe('/x/push.log');
    expect(() => testPushOutbox('/x/push.log', 'prod')).toThrow(/only when APP_ENV is exactly dev or test/);
    expect(() => testPushOutbox('/x/push.log', undefined)).toThrow(/only when APP_ENV/);
    expect(() => testPushOutbox('push.log', 'dev')).toThrow(/absolute path/);
  });

  it('stands in for push only while the push gateway is blank, and is available at the door', () => {
    const file = outboxFile();
    const base = { NOTIFY_GATEWAY_TIMEOUT_MS: 1000, NOTIFY_REQUIRED_CHANNELS: 'none', APP_ENV: 'test', NOTIFY_PUSH_TEST_OUTBOX: file };
    const standIn = channelsFromEnv(base);
    expect(standIn.get('push')).toBeInstanceOf(TestOutboxPushChannel);
    expect(standIn.status().find((row) => row.channel === 'push')).toMatchObject({ configured: true, available: true });
    const real = channelsFromEnv({
      ...base,
      NOTIFY_PUSH_GATEWAY_URL: 'https://push.example.test/send',
      NOTIFY_PUSH_GATEWAY_TOKEN: 'x'.repeat(16),
    });
    expect(real.get('push')).not.toBeInstanceOf(TestOutboxPushChannel);
    expect(channelsFromEnv({ ...base, NOTIFY_PUSH_TEST_OUTBOX: undefined }).get('push').unavailableReason).toBe('channel.not_configured');
  });

  it('writes each message as one LOCAL-TEST line labelled TEST, to the device address it was for', async () => {
    const file = outboxFile();
    const channel = new TestOutboxPushChannel(file);
    const receipt = await channel.deliver({
      notificationId: 'verify:u1:push',
      userId: 'u1',
      channel: 'push',
      kind: 'notify.channel.verify',
      severity: 'action',
      titleKey: 'notify.channel.verify.title',
      bodyKey: 'notify.channel.verify.body',
      title: 'Confirm this device',
      body: 'Your code is 123456.',
      href: null,
      locale: 'en',
      address: '{"endpoint":"https://push.local-test.invalid/d1"}',
      idempotencyKey: 'verify:u1:push:1',
    });
    expect(receipt).toEqual({ reference: 'local-test:verify:u1:push:1' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith('LOCAL-TEST ')).toBe(true);
    const line = JSON.parse(lines[0]!.slice('LOCAL-TEST '.length));
    expect(line).toMatchObject({
      kind: 'notify.channel.verify',
      to: '{"endpoint":"https://push.local-test.invalid/d1"}',
      title: 'TEST · Confirm this device',
    });
    expect(line.body).toMatch(/^TEST — written by the LOCAL TEST push stand-in, not sent\. Your code is 123456\.$/);
  });
});
