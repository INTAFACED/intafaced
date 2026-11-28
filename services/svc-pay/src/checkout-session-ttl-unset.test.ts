import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayError, publishedCheckoutSessionTtlSeconds } from './payment-service.js';
import { payEnv } from './env.testkit.js';
import { scriptedCheckout, wroteSession } from './checkout-open.testkit.js';

/**
 * Owner hosted-checkout session lifetime is refuse-closed when unset.
 *
 * `z.coerce.number().default(900)` treated blank TTL env as a published
 * browser handoff. Blank is unset; 900 only when the owner publishes it.
 * Open-path refuse with a real merchant lives in payment-service.test.ts (PG-hard).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('PAY_CHECKOUT_SESSION_TTL_SECONDS unset refuse', () => {
  it('the boot settings refuse a blank lifetime rather than defaulting it to 900', () => {
    for (const blank of [undefined, '', ' ', '0', '59']) {
      expect(() => payEnv({ PAY_CHECKOUT_SESSION_TTL_SECONDS: blank })).toThrow(/PAY_CHECKOUT_SESSION_TTL_SECONDS/);
    }
    expect(payEnv({ PAY_CHECKOUT_SESSION_TTL_SECONDS: '900' }).PAY_CHECKOUT_SESSION_TTL_SECONDS).toBe(900);
    expect(payEnv({ PAY_CHECKOUT_SESSION_TTL_SECONDS: '60' }).PAY_CHECKOUT_SESSION_TTL_SECONDS).toBe(60);
  });

  it('compose refuses missing — never a baked 900', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(
      /PAY_CHECKOUT_SESSION_TTL_SECONDS:\s*\$\{PAY_CHECKOUT_SESSION_TTL_SECONDS:\?missing — copy \.env\.example to \.env\}/,
    );
    expect(block).not.toMatch(/PAY_CHECKOUT_SESSION_TTL_SECONDS:\s*\$\{PAY_CHECKOUT_SESSION_TTL_SECONDS:-900\}/);
    expect(block).not.toMatch(/PAY_CHECKOUT_SESSION_TTL_SECONDS:\s*['"]?900/);
  });

  it('a service built without the lifetime refuses to open a checkout and writes no session — never 900', async () => {
    const { pay, calls } = scriptedCheckout({ maxOpenSessionsPerLink: 25 });
    await expect(pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' })).rejects.toMatchObject({
      code: 'pay.checkout_session_ttl_unset',
    });
    expect(wroteSession(calls)).toBe(false);
  });

  it('a service built with the owner lifetime gives the session exactly that long', async () => {
    const now = new Date();
    const { pay, calls } = scriptedCheckout({ maxOpenSessionsPerLink: 25, checkoutSessionTtlSeconds: 120, now: () => now });
    await pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' }).catch(() => undefined);
    const insert = calls.find((c) => c.text.includes('INSERT INTO pay.checkout_sessions'));
    expect(insert, 'a session row was written').toBeDefined();
    expect(insert!.values).toContainEqual(new Date(now.getTime() + 120_000));
  });

  it('publishedCheckoutSessionTtlSeconds refuses null rather than inventing 900', () => {
    expect(() => publishedCheckoutSessionTtlSeconds(null)).toThrow(PayError);
    expect(() => publishedCheckoutSessionTtlSeconds(undefined)).toThrow(
      expect.objectContaining({ code: 'pay.checkout_session_ttl_unset' }),
    );
    expect(publishedCheckoutSessionTtlSeconds(900)).toBe(900);
    expect(publishedCheckoutSessionTtlSeconds(60)).toBe(60);
  });
});
