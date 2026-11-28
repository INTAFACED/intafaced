import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { payEnv } from './env.testkit.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { MemoryChain } from './rails/chain-port.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';

/**
 * Owner signed-webhook replay window is refuse-closed when unset.
 *
 * `z.coerce.number().default(300)` treated blank skew env as a published
 * 300s replay window. Blank is unset; 300 only when the owner publishes it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('PAY_WEBHOOK_TOLERANCE_SECONDS unset refuse', () => {
  it('the boot settings refuse a blank window rather than defaulting it to 300', () => {
    for (const blank of [undefined, '', ' ', '0', '29']) {
      expect(() => payEnv({ PAY_WEBHOOK_TOLERANCE_SECONDS: blank })).toThrow(/PAY_WEBHOOK_TOLERANCE_SECONDS/);
    }
    expect(payEnv({ PAY_WEBHOOK_TOLERANCE_SECONDS: '300' }).PAY_WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    expect(payEnv({ PAY_WEBHOOK_TOLERANCE_SECONDS: '30' }).PAY_WEBHOOK_TOLERANCE_SECONDS).toBe(30);
  });

  it('compose refuses missing — never a baked 300', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(/PAY_WEBHOOK_TOLERANCE_SECONDS:\s*\$\{PAY_WEBHOOK_TOLERANCE_SECONDS:\?missing — copy \.env\.example to \.env\}/);
    expect(block).not.toMatch(/PAY_WEBHOOK_TOLERANCE_SECONDS:\s*\$\{PAY_WEBHOOK_TOLERANCE_SECONDS:-300\}/);
    expect(block).not.toMatch(/PAY_WEBHOOK_TOLERANCE_SECONDS:\s*['"]?300/);
  });

  it('inbound rails take the window they are given — never 300 of their own', () => {
    // The window is a required number on both rails' options; what each rail then accepts is exactly that window.
    const now = new Date('2026-11-28T12:00:00.000Z');
    const secret = 'webhook-tolerance-secret-at-least-32-chars';
    const payload = { id: 'evt_1', ref: 'ch_1', type: 'captured', amount: '1' };
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    for (const windowSeconds of [60, 600]) {
      const card = new CardSandboxAdapter({ secret, toleranceSeconds: windowSeconds, now: () => now });
      const crypto = new CryptoNativeAdapter({
        chain: new MemoryChain(),
        secret,
        minConfirmations: 6,
        toleranceSeconds: windowSeconds,
        now: () => now,
      });
      for (const rail of [card, crypto]) {
        expect(
          rail.verifyWebhook(rail.signWebhook(payload, ago(windowSeconds - 10))),
          `${rail.id} inside ${windowSeconds}s`,
        ).not.toBeNull();
        expect(rail.verifyWebhook(rail.signWebhook(payload, ago(windowSeconds + 10))), `${rail.id} past ${windowSeconds}s`).toBeNull();
      }
    }
  });
});
