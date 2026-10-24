import { describe, expect, it } from 'vitest';
import { IDENTITY_HOLDER_NAME_CHECK_PATH } from '@intafaced/contracts';
import { createIdentityHolderNameRule, unwiredHolderNameRule } from './holder-name.js';

const SELLER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'p'.repeat(32);

/** identity, faked: answers `status` with `body`, and keeps what it was sent. */
function identity(status: number, body: unknown) {
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, rule: createIdentityHolderNameRule('http://identity.test/', SECRET, undefined, fetchFn) };
}

describe('the own-name rule through identity (P-ads-merchant-18)', () => {
  it('passes only a match, and sends the owner and the name to the holder-name door, signed', async () => {
    const { sent, rule } = identity(200, { userId: SELLER.toUpperCase(), outcome: 'match' });
    await expect(rule.assertOwnName(SELLER, 'A Seller')).resolves.toBeUndefined();
    expect(sent[0]!.url).toBe(`http://identity.test${IDENTITY_HOLDER_NAME_CHECK_PATH}`);
    expect(JSON.parse(sent[0]!.body)).toEqual({ userId: SELLER, name: 'A Seller' });
    expect(Object.keys(sent[0]!.headers).some((header) => header.toLowerCase().startsWith('x-intafaced-service'))).toBe(true);
  });

  it.each([
    ['mismatch', 'p2p.holder_name_mismatch'],
    ['unverified', 'p2p.holder_name_unverified'],
    ['inactive', 'p2p.holder_name_unverifiable'],
    ['unconfigured', 'p2p.holder_name_unverifiable'],
  ])('refuses %s as %s', async (outcome, code) => {
    await expect(identity(200, { userId: SELLER, outcome }).rule.assertOwnName(SELLER, 'A Seller')).rejects.toMatchObject({ code });
  });

  it('refuses whenever identity cannot say: a refusal, a missing account, another account, an answer out of shape, no answer', async () => {
    for (const [status, body] of [
      [503, { code: 'identity.details_unreadable' }],
      [404, { code: 'identity.account_not_found' }],
      [200, { userId: '22222222-2222-4222-8222-222222222222', outcome: 'match' }],
      [200, { userId: SELLER, outcome: 'probably' }],
      [200, { userId: SELLER, outcome: 'match', legalName: 'A Seller' }],
    ] as const) {
      await expect(identity(status, body).rule.assertOwnName(SELLER, 'A Seller')).rejects.toMatchObject({
        code: 'p2p.holder_name_unverifiable',
      });
    }
    const down = createIdentityHolderNameRule('http://identity.test', SECRET, undefined, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(down.assertOwnName(SELLER, 'A Seller')).rejects.toMatchObject({ code: 'p2p.holder_name_unverifiable' });
    await expect(unwiredHolderNameRule().assertOwnName(SELLER, 'A Seller')).rejects.toMatchObject({ code: 'p2p.holder_name_unverifiable' });
  });

  it('never puts the typed name in a refusal', async () => {
    const refused = await identity(200, { userId: SELLER, outcome: 'mismatch' })
      .rule.assertOwnName(SELLER, 'Zebediah Quux')
      .catch((err: Error) => err);
    expect((refused as Error).message).not.toContain('Zebediah');
  });
});
