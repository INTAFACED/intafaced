import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { assertExtrasAllow, createIdentityExtraControls, memoryExtraControls, unconfiguredExtraControls } from './extra-controls.js';

// BK-safe-01, J-bank-18 #4: the person's own extra checks hold a send to another person above their allowance.
const ME = '11111111-1111-4111-8111-111111111111';
const SECRET = 'an-internal-service-secret-for-the-extra-checks-test';
const THEM = '22222222-2222-4222-8222-222222222222';
const extras = memoryExtraControls({
  [ME]: { controls: ['secret_qr', 'trusted_contacts'], allowance: { amount: '500', assetId: 'USDT' } },
});
const send = (amount: string, over: Partial<{ toUserId: string; assetId: string }> = {}) =>
  assertExtrasAllow(extras, { userId: ME, toUserId: THEM, assetId: 'USDT', amount: parseAmount(amount), ...over });

describe('extra checks on a send (BK-safe-01)', () => {
  it('holds a send above the allowance, and lets one at or under it through', async () => {
    await expect(send('600')).rejects.toMatchObject({ code: 'bank.extra_controls_pending' });
    await expect(send('500.00000001')).rejects.toMatchObject({ code: 'bank.extra_controls_pending' });
    await expect(send('500')).resolves.toBeUndefined();
    await expect(send('400')).resolves.toBeUndefined();
  });

  it('leaves a send to oneself, in another asset, or by a person with no extras alone', async () => {
    await expect(send('600', { toUserId: ME })).resolves.toBeUndefined();
    await expect(send('600', { assetId: 'USDC' })).resolves.toBeUndefined();
    await expect(
      assertExtrasAllow(extras, { userId: THEM, toUserId: ME, assetId: 'USDT', amount: parseAmount('9999') }),
    ).resolves.toBeUndefined();
  });

  it('refuses when identity cannot answer or is not wired, never lets the send through', async () => {
    const down = memoryExtraControls();
    down.failWith(new BankError('down', 'bank.extra_controls_unavailable'));
    await expect(assertExtrasAllow(down, { userId: ME, toUserId: THEM, assetId: 'USDT', amount: parseAmount('1') })).rejects.toMatchObject({
      code: 'bank.extra_controls_unavailable',
    });
    await expect(
      assertExtrasAllow(unconfiguredExtraControls(), { userId: ME, toUserId: THEM, assetId: 'USDT', amount: parseAmount('1') }),
    ).rejects.toMatchObject({ code: 'bank.extra_controls_unset' });
  });

  it('reads identity’s answer, and treats an error, an unreadable body or another person’s answer as unavailable', async () => {
    const answer =
      (status: number, body: unknown): typeof fetch =>
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const refused: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const good = { userId: ME, controls: ['secret_qr'], allowance: { amount: '5', assetId: 'USDC' } };
    await expect(createIdentityExtraControls('http://identity.test', SECRET, answer(200, good)).read(ME)).resolves.toEqual(good);
    for (const fetchFn of [
      answer(500, {}),
      answer(200, 'not json'),
      answer(200, { ...good, userId: THEM }),
      answer(200, { userId: ME }),
      refused,
    ]) {
      await expect(createIdentityExtraControls('http://identity.test', SECRET, fetchFn).read(ME)).rejects.toMatchObject({
        code: 'bank.extra_controls_unavailable',
      });
    }
  });
});
