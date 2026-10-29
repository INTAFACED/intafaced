import { describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody, WALLET_SIGNATURE_VERIFY_PATH } from '@intafaced/contracts';
import { createIdentityVoteSignatures, voteMessage } from './vote-signature.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SIGNATURE = `0x${'ab'.repeat(65)}`;

describe('voteMessage', () => {
  it('binds the proposal, the person and the vote, with keys in one order whatever order the ballot arrived in', () => {
    expect(voteMessage({ proposalId: 'p-1', userId: USER, choice: 'for' })).toBe(
      `{"purpose":"INTAFACED governance vote","origin":"svc-token","proposalId":"p-1","userId":"${USER}","choice":"for"}`,
    );
    const split = { kind: 'split' as const, parts: [{ bps: 4000, choice: 1 } as { choice: number; bps: number }] };
    expect(voteMessage({ proposalId: 'p-1', userId: USER, ballot: split })).toBe(
      `{"purpose":"INTAFACED governance vote","origin":"svc-token","proposalId":"p-1","userId":"${USER}","ballot":{"kind":"split","parts":[{"choice":1,"bps":4000}]}}`,
    );
    const pick = voteMessage({ proposalId: 'p-1', userId: USER, ballot: { kind: 'pick', choices: [2, 0] } });
    expect(pick).not.toBe(voteMessage({ proposalId: 'p-1', userId: USER, ballot: { kind: 'pick', choices: [0, 2] } }));
    expect(pick).not.toBe(voteMessage({ proposalId: 'p-2', userId: USER, ballot: { kind: 'pick', choices: [2, 0] } }));
  });
});

describe('createIdentityVoteSignatures', () => {
  it('posts a service-signed body to identity and reads its answer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const port = createIdentityVoteSignatures('http://identity.test/', 's'.repeat(32), async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ state: 'linked', address: `0x${'cd'.repeat(20)}` }), { status: 200 });
    });
    const input = { userId: USER, message: 'TEST', signature: SIGNATURE };
    expect(await port.verify(input)).toEqual({ state: 'linked', address: `0x${'cd'.repeat(20)}` });
    expect(calls[0]!.url).toBe(`http://identity.test${WALLET_SIGNATURE_VERIFY_PATH}`);
    expect(calls[0]!.init.body).toBe(JSON.stringify(input));
    const expected = serviceAuthHeadersForBody('svc-token', 's'.repeat(32), JSON.stringify(input));
    for (const [name, value] of Object.entries(expected)) {
      if (!/timestamp|nonce|signature/i.test(name)) expect((calls[0]!.init.headers as Record<string, string>)[name]).toBe(value);
    }
    expect(calls[0]!.init.redirect).toBe('error');
  });

  it('answers null when identity fails, answers non-2xx, or answers outside the schema', async () => {
    const input = { userId: USER, message: 'TEST', signature: SIGNATURE };
    const failing = createIdentityVoteSignatures('http://identity.test', 's'.repeat(32), async () => {
      throw new TypeError('fetch failed');
    });
    expect(await failing.verify(input)).toBeNull();
    const refusing = createIdentityVoteSignatures('http://identity.test', 's'.repeat(32), async () => new Response('{}', { status: 403 }));
    expect(await refusing.verify(input)).toBeNull();
    const odd = createIdentityVoteSignatures('http://identity.test', 's'.repeat(32), async () => new Response('{"state":"maybe"}'));
    expect(await odd.verify(input)).toBeNull();
    const garbled = createIdentityVoteSignatures('http://identity.test', 's'.repeat(32), async () => new Response('not json'));
    expect(await garbled.verify(input)).toBeNull();
  });
});
