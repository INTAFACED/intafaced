import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { PayQrError, PayQrService, payQrKeyFromEnv, verifyPayQr } from './pay-qr.js';

const KEY = 'a-pay-qr-unit-test-key-that-is-long-enough';
const PAYEE = '0b5f4c7e-3c2a-4f61-9d3e-7a1b2c3d4e5f';
const PAYER = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** A sql stand-in that records every read and answers `rows`. */
function recordingSql(rows: Array<{ id: string; handle: string }>) {
  const reads: unknown[][] = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    reads.push(values);
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return { sql, reads };
}

const holder = (userId: string) => ({ userId, apiKey: false, subAccount: false });

async function refusal(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PayQrError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('pay QR payload', () => {
  it('names the payee by account id and resolves to their preview', async () => {
    const { sql, reads } = recordingSql([{ id: PAYEE, handle: 'payee_a' }]);
    const service = new PayQrService(sql, KEY);
    const { payload } = service.mine(holder(PAYEE));
    expect(payload.split('.')[1]).toBe(PAYEE);
    expect(payload).not.toContain('payee_a');
    await expect(service.resolve(holder(PAYER), payload)).resolves.toEqual({ userId: PAYEE, handle: 'payee_a', self: false });
    expect(reads).toEqual([[PAYEE]]);
  });

  it('says when the code is the payer’s own', async () => {
    const { sql } = recordingSql([{ id: PAYEE, handle: 'payee_a' }]);
    const service = new PayQrService(sql, KEY);
    const { payload } = service.mine(holder(PAYEE));
    await expect(service.resolve(holder(PAYEE), payload)).resolves.toMatchObject({ self: true });
  });

  it('refuses a tampered payload before any read of the payee', async () => {
    const { sql, reads } = recordingSql([{ id: PAYER, handle: 'someone_else' }]);
    const service = new PayQrService(sql, KEY);
    const { payload } = service.mine(holder(PAYEE));
    const [v, , sig] = payload.split('.') as [string, string, string];
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const otherKey = new PayQrService(sql, `${KEY}-other`).mine(holder(PAYEE)).payload;
    for (const bad of [
      `${v}.${PAYER}.${sig}`, // the signature moved onto another account
      `${v}.${PAYEE}.${flipped}`,
      `v2.${PAYEE}.${sig}`,
      `${v}.${PAYEE}`,
      `${payload}.extra`,
      otherKey,
      'not a code',
      `${payload}${'x'.repeat(200)}`,
    ]) {
      expect(await refusal(() => service.resolve(holder(PAYER), bad))).toBe('identity.qr_invalid');
    }
    expect(reads).toEqual([]);
  });

  it('refuses issue and resolve with qr_key_unset when the key is blank, reading nothing', async () => {
    const { sql, reads } = recordingSql([{ id: PAYEE, handle: 'payee_a' }]);
    const signed = new PayQrService(sql, KEY).mine(holder(PAYEE)).payload;
    const blank = new PayQrService(sql, payQrKeyFromEnv('  ', 'test'));
    expect(await refusal(() => blank.mine(holder(PAYEE)))).toBe('identity.qr_key_unset');
    expect(await refusal(() => blank.resolve(holder(PAYER), signed))).toBe('identity.qr_key_unset');
    expect(reads).toEqual([]);
  });

  it('refuses a verified code for an account that cannot be paid', async () => {
    const { sql } = recordingSql([]);
    const service = new PayQrService(sql, KEY);
    const { payload } = service.mine(holder(PAYEE));
    expect(await refusal(() => service.resolve(holder(PAYER), payload))).toBe('identity.qr_payee_unavailable');
  });

  it('issues no code to an API key or a sub-account', async () => {
    const service = new PayQrService(recordingSql([]).sql, KEY);
    expect(await refusal(() => service.mine({ userId: PAYEE, apiKey: true, subAccount: false }))).toBe('identity.delegated_refused');
    expect(await refusal(() => service.mine({ userId: PAYEE, apiKey: false, subAccount: true }))).toBe('identity.delegated_refused');
  });

  it('verifies only its own payload shape', () => {
    const { payload } = new PayQrService(recordingSql([]).sql, KEY).mine(holder(PAYEE));
    expect(verifyPayQr(KEY, payload)).toBe(PAYEE);
    expect(verifyPayQr(KEY, payload.toUpperCase())).toBeNull();
  });
});

describe('IDENTITY_PAY_QR_KEY at boot', () => {
  it('reads blank as not set', () => {
    expect(payQrKeyFromEnv(undefined, 'prod')).toBeNull();
    expect(payQrKeyFromEnv('', 'prod')).toBeNull();
  });

  it('refuses a short key', () => {
    expect(() => payQrKeyFromEnv('short', 'prod')).toThrow(/at least 32/);
  });

  it('takes the local-test TEST key only when APP_ENV is exactly dev or test', () => {
    const testKey = `local-test:${'f'.repeat(64)}`;
    expect(payQrKeyFromEnv(testKey, 'dev')).toBe(testKey);
    expect(payQrKeyFromEnv(testKey, 'test')).toBe(testKey);
    for (const appEnv of [undefined, '', 'staging', 'prod', 'DEV']) {
      expect(() => payQrKeyFromEnv(testKey, appEnv)).toThrow(/refused unless APP_ENV is exactly dev or test/);
    }
  });

  it('takes a real key anywhere', () => {
    expect(payQrKeyFromEnv(KEY, 'prod')).toBe(KEY);
  });
});
