import { describe, expect, it } from 'vitest';
import { AGENT_KEY_CALLS_PATH, AGENT_KEY_READ_PATH } from '@intafaced/contracts';
import { createAgentKeyCallReader, createAgentKeyReader } from './agent-key-read-client.js';

// svc-trade's call to identity's agent-key read (J-agents-21 #6): signed as svc-trade, and anything outside the contract
// is `null`, which the connect route refuses `agents.key_read_unavailable`, never a guess.

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const SECRET = 's'.repeat(32);

function reader(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { r: createAgentKeyReader('http://identity.test/', SECRET, undefined, fetchFn), calls };
}

describe('createAgentKeyReader', () => {
  it("posts the person's id and the key id to identity's door, signed as svc-trade, and returns the contract's answer", async () => {
    const found = { state: 'found', keyId: KEY, kind: 'agent', scopes: ['trade:write'], revoked: false };
    const { r, calls } = reader(() => Response.json(found));
    expect(await r.read(USER, KEY)).toEqual(found);
    expect(calls[0]!.url).toBe(`http://identity.test${AGENT_KEY_READ_PATH}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userId: USER, keyId: KEY });
    expect(JSON.stringify(calls[0]!.init.headers)).toContain('svc-trade');
  });

  it('answers null on a refusal, a shape outside the contract, or no answer', async () => {
    expect(await reader(() => new Response('{}', { status: 403 })).r.read(USER, KEY)).toBeNull();
    expect(await reader(() => Response.json({ state: 'found', keyId: KEY })).r.read(USER, KEY)).toBeNull();
    expect(
      await reader(() => {
        throw new Error('down');
      }).r.read(USER, KEY),
    ).toBeNull();
  });
});

describe('createAgentKeyCallReader', () => {
  function callReader(answer: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answer();
    }) as typeof fetch;
    return { r: createAgentKeyCallReader('http://identity.test/', SECRET, undefined, fetchFn), calls };
  }

  it("asks identity's door for the key's log, signed as svc-trade, and returns the contract's answer", async () => {
    const log = {
      state: 'found',
      keyId: KEY,
      asOf: '2026-11-13T00:00:00.000Z',
      calls: [
        {
          requestId: 'r1',
          method: 'GET',
          path: '/api/v1/venue/balances',
          status: 403,
          outsideIpList: false,
          at: '2026-11-13T00:00:00.000Z',
        },
      ],
    };
    const { r, calls } = callReader(() => Response.json(log));
    expect(await r.calls(USER, KEY, 50)).toEqual(log);
    expect(calls[0]!.url).toBe(`http://identity.test${AGENT_KEY_CALLS_PATH}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userId: USER, keyId: KEY, limit: 50 });
    expect(JSON.stringify(calls[0]!.init.headers)).toContain('svc-trade');
  });

  it('answers null on a refusal, a shape outside the contract, or no answer', async () => {
    expect(await callReader(() => new Response('{}', { status: 403 })).r.calls(USER, KEY, 5)).toBeNull();
    expect(await callReader(() => Response.json({ state: 'found', keyId: KEY })).r.calls(USER, KEY, 5)).toBeNull();
    expect(
      await callReader(() => {
        throw new Error('down');
      }).r.calls(USER, KEY, 5),
    ).toBeNull();
  });
});
