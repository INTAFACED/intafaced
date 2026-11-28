import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayError, publishedMaxOpenSessionsPerLink } from './payment-service.js';
import { payEnv } from './env.testkit.js';
import { scriptedCheckout, wrotePayment, wroteSession } from './checkout-open.testkit.js';

/**
 * Owner hosted-checkout open-session cap is refuse-closed when unset.
 *
 * `z.coerce.number().default(25)` treated blank cap env as a published floor.
 * Blank is unset; 25 only when the owner publishes it.
 * Open-path refuse with a real merchant lives in payment-service.test.ts (PG-hard).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('PAY_CHECKOUT_MAX_OPEN_SESSIONS unset refuse', () => {
  it('the boot settings refuse a blank cap rather than defaulting it to 25', () => {
    for (const blank of [undefined, '', ' ', '0']) {
      expect(() => payEnv({ PAY_CHECKOUT_MAX_OPEN_SESSIONS: blank })).toThrow(/PAY_CHECKOUT_MAX_OPEN_SESSIONS/);
    }
    expect(payEnv({ PAY_CHECKOUT_MAX_OPEN_SESSIONS: '25' }).PAY_CHECKOUT_MAX_OPEN_SESSIONS).toBe(25);
    expect(payEnv({ PAY_CHECKOUT_MAX_OPEN_SESSIONS: '1' }).PAY_CHECKOUT_MAX_OPEN_SESSIONS).toBe(1);
  });

  it('compose refuses missing — never a baked 25', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const start = compose.indexOf('\n  svc-pay:');
    const rest = compose.slice(start + 1);
    const next = rest.search(/\n  svc-[a-z]+:/);
    const block = next === -1 ? rest : rest.slice(0, next);
    expect(block).toMatch(
      /PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*\$\{PAY_CHECKOUT_MAX_OPEN_SESSIONS:\?missing — copy \.env\.example to \.env\}/,
    );
    expect(block).not.toMatch(/PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*\$\{PAY_CHECKOUT_MAX_OPEN_SESSIONS:-25\}/);
    expect(block).not.toMatch(/PAY_CHECKOUT_MAX_OPEN_SESSIONS:\s*['"]?25/);
  });

  it('a service built without the cap refuses to open a checkout before any payment or session — never 25', async () => {
    const { pay, calls } = scriptedCheckout({ checkoutSessionTtlSeconds: 900 });
    await expect(pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' })).rejects.toMatchObject({
      code: 'pay.checkout_max_open_sessions_unset',
    });
    expect(wrotePayment(calls)).toBe(false);
    expect(wroteSession(calls)).toBe(false);
  });

  it('a service built with the owner cap refuses the link once that many sessions are open, and not before', async () => {
    const full = scriptedCheckout({ checkoutSessionTtlSeconds: 900, maxOpenSessionsPerLink: 3 }, { openSessions: 3 });
    await expect(full.pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' })).rejects.toMatchObject({
      code: 'pay.checkout_busy',
      detail: { limit: 3 },
    });
    expect(wrotePayment(full.calls)).toBe(false);
    const room = scriptedCheckout({ checkoutSessionTtlSeconds: 900, maxOpenSessionsPerLink: 3 }, { openSessions: 2 });
    await room.pay.openCheckoutSession({ linkToken: 'pl_test_token', geoCountry: 'DE' }).catch(() => undefined);
    expect(wrotePayment(room.calls)).toBe(true);
  });

  it('publishedMaxOpenSessionsPerLink refuses null rather than inventing 25', () => {
    expect(() => publishedMaxOpenSessionsPerLink(null)).toThrow(PayError);
    expect(() => publishedMaxOpenSessionsPerLink(undefined)).toThrow(
      expect.objectContaining({ code: 'pay.checkout_max_open_sessions_unset' }),
    );
    expect(publishedMaxOpenSessionsPerLink(25)).toBe(25);
    expect(publishedMaxOpenSessionsPerLink(1)).toBe(1);
  });
});
