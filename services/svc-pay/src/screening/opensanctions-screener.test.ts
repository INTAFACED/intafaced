import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { FRESH, PayGuardRefusal, type PayoutExecuteContext } from '../seams/guards.js';
import { createScreeningGuards, type ScreeningSubject } from './guard.js';
import { openScreeningScreener } from './local-test-screener.js';
import {
  OPENSANCTIONS_DATASETS,
  createOpenSanctionsScreener,
  type ScreeningParty,
  type ScreeningPartyResolver,
} from './opensanctions-screener.js';
import { createMemoryScreeningCaseStore } from './store.js';

/** TEST fixtures only: a made-up key, party and amounts. */
const TEST_KEY = 'test-key-0f1e2d3c4b5a';
const MERCHANT = '22222222-2222-4222-8222-222222222222';
const SUBJECT: ScreeningSubject = { kind: 'payout', partyRef: MERCHANT, assetId: 'USDT', amount: '1' };
const PARTY: ScreeningParty = { schema: 'Organization', names: ['TEST Trading Ltd'], country: 'GB' };
const resolveTo =
  (party: ScreeningParty | null): ScreeningPartyResolver =>
  async () =>
    party;

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch answering with the documented `/match` reply shape (responses → query id → status, results[].match). */
function vendor(reply: (seen: Seen) => Response | Promise<Response>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    };
    seen.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const matchReply = (results: Array<{ match: boolean; score: number }>, status = 200) =>
  new Response(
    JSON.stringify({
      responses: {
        party: {
          status,
          results: results.map((r, i) => ({
            id: `NK-test-${i}`,
            caption: 'TEST',
            schema: 'Organization',
            datasets: ['us_ofac_sdn'],
            ...r,
          })),
          total: { value: results.length, relation: 'eq' },
          query: {},
        },
      },
      limit: 5,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function screener(fetchImpl: typeof fetch, party: ScreeningParty | null = PARTY) {
  return createOpenSanctionsScreener({ apiKey: TEST_KEY, resolveParty: resolveTo(party), fetchImpl });
}

describe('the OpenSanctions screener', () => {
  it('asks /match/default scoped to exactly the four official lists, with the ApiKey header', async () => {
    const { fetchImpl, seen } = vendor(() => matchReply([]));
    await screener(fetchImpl)(SUBJECT);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.opensanctions.org/match/default');
    expect(url.searchParams.getAll('include_dataset')).toEqual(['us_ofac_sdn', 'un_sc_sanctions', 'eu_fsf', 'gb_fcdo_sanctions']);
    expect(OPENSANCTIONS_DATASETS).toHaveLength(4);
    expect(seen[0]!.headers.authorization).toBe(`ApiKey ${TEST_KEY}`);
    expect(seen[0]!.body).toEqual({
      queries: { party: { schema: 'Organization', properties: { name: ['TEST Trading Ltd'], country: ['gb'] } } },
    });
  });

  it('sends a person with birth date and nationality', async () => {
    const { fetchImpl, seen } = vendor(() => matchReply([]));
    await screener(fetchImpl, { schema: 'Person', names: ['TEST Person'], birthDate: '1980-01-02', country: 'DE' })({
      ...SUBJECT,
      kind: 'withdrawal',
    });
    expect(seen[0]!.body).toEqual({
      queries: {
        party: { schema: 'Person', properties: { name: ['TEST Person'], birthDate: ['1980-01-02'], nationality: ['de'] } },
      },
    });
  });

  it('a result marked match → review; only results under the threshold → clear', async () => {
    await expect(screener(vendor(() => matchReply([{ match: true, score: 0.91 }])).fetchImpl)(SUBJECT)).resolves.toEqual({
      category: 'review',
      factors: [{ code: 'sanctions_list_match' }],
    });
    await expect(screener(vendor(() => matchReply([{ match: false, score: 0.4 }])).fetchImpl)(SUBJECT)).resolves.toEqual({
      category: 'clear',
      factors: [{ code: 'sanctions_list_clear' }],
    });
    await expect(screener(vendor(() => matchReply([])).fetchImpl)(SUBJECT)).resolves.toMatchObject({ category: 'clear' });
  });

  it('vendor down, refused, or speaking another shape → unavailable provider_down, never clear', async () => {
    const down = { category: 'unavailable', factors: [{ code: 'provider_down' }] };
    const cases: Array<() => Response | Promise<Response>> = [
      () => new Response('nope', { status: 401 }),
      () => new Response('slow down', { status: 429 }),
      () => new Response('{"detail":"boom"}', { status: 500 }),
      () => new Response('<html>not json</html>', { status: 200 }),
      () => new Response(JSON.stringify({ responses: {} }), { status: 200 }),
      () => new Response(JSON.stringify({ hits: [] }), { status: 200 }),
      () => matchReply([{ match: true, score: 0.9 }], 500),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    ];
    for (const reply of cases) await expect(screener(vendor(reply).fetchImpl)(SUBJECT)).resolves.toEqual(down);
  });

  it('a party it cannot name is unavailable and the vendor is never asked', async () => {
    const { fetchImpl, seen } = vendor(() => matchReply([]));
    const unresolved = { category: 'unavailable', factors: [{ code: 'party_unresolved' }] };
    await expect(screener(fetchImpl, null)(SUBJECT)).resolves.toEqual(unresolved);
    await expect(screener(fetchImpl, { schema: 'Organization', names: ['  '] })(SUBJECT)).resolves.toEqual(unresolved);
    const throwing = createOpenSanctionsScreener({
      apiKey: TEST_KEY,
      resolveParty: async () => {
        throw new Error('db down');
      },
      fetchImpl,
    });
    await expect(throwing(SUBJECT)).resolves.toEqual(unresolved);
    expect(seen).toHaveLength(0);
  });
});

describe('the guard with OpenSanctions installed', () => {
  function payoutCtx(): PayoutExecuteContext {
    return {
      sql: {} as Sql,
      settlementId: '11111111-1111-4111-8111-111111111111',
      merchantId: MERCHANT,
      assetId: 'USDT',
      amount: 1n,
      railId: 'crypto-native',
      destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
      attempt: 0,
      replay: FRESH,
    };
  }
  async function refusalOf(reply: () => Response | Promise<Response>): Promise<string | null> {
    const opened = openScreeningScreener({
      appEnv: 'production',
      setting: 'opensanctions',
      openSanctionsApiKey: TEST_KEY,
      resolveParty: resolveTo(PARTY),
      fetchImpl: vendor(reply).fetchImpl,
    })!;
    const guards = createScreeningGuards({ sql: {} as Sql, store: createMemoryScreeningCaseStore(), ...opened });
    try {
      await guards.beforePayoutExecute!(payoutCtx());
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(PayGuardRefusal);
      return (error as PayGuardRefusal).code;
    }
  }

  it('a match holds the send for review, no match lets it go, a vendor outage refuses it unavailable', async () => {
    await expect(refusalOf(() => matchReply([{ match: true, score: 0.95 }]))).resolves.toBe('pay.guard_screening_review');
    await expect(refusalOf(() => matchReply([]))).resolves.toBeNull();
    await expect(refusalOf(() => new Response('', { status: 503 }))).resolves.toBe('pay.guard_screening_unavailable');
  });
});

describe('the opensanctions setting', () => {
  it('blank setting still installs nothing (every custodial send refused unavailable, as today)', () => {
    expect(openScreeningScreener({ appEnv: 'production', setting: '', openSanctionsApiKey: TEST_KEY })).toBeNull();
  });

  it('is labelled opensanctions and counts as a named list, in any APP_ENV', () => {
    const opened = openScreeningScreener({
      appEnv: 'production',
      setting: 'opensanctions',
      openSanctionsApiKey: TEST_KEY,
      resolveParty: resolveTo(PARTY),
    })!;
    expect(opened.providerLabel).toBe('opensanctions');
    expect(opened.listPosture).toBe('named');
  });

  it('refuses to boot without its key, naming the setting', () => {
    for (const openSanctionsApiKey of [undefined, '', '   '])
      expect(() =>
        openScreeningScreener({ appEnv: 'production', setting: 'opensanctions', openSanctionsApiKey, resolveParty: resolveTo(PARTY) }),
      ).toThrow('pay.screening_screener_refused: OPENSANCTIONS_API_KEY is blank');
    expect(() => createOpenSanctionsScreener({ apiKey: ' ', resolveParty: resolveTo(PARTY) })).toThrow(/OPENSANCTIONS_API_KEY is blank/);
  });

  it('never puts the key in a thrown message or an answer', async () => {
    const messages: string[] = [];
    try {
      openScreeningScreener({ appEnv: 'production', setting: 'opensanctions', openSanctionsApiKey: TEST_KEY });
    } catch (error) {
      messages.push(String((error as Error).message));
    }
    for (const reply of [
      () => new Response(`bad key ${TEST_KEY}`, { status: 401 }),
      () => Promise.reject(new Error(`echo ${TEST_KEY}`)),
      () => matchReply([{ match: true, score: 1 }]),
    ]) {
      messages.push(JSON.stringify(await screener(vendor(reply).fetchImpl)(SUBJECT)));
    }
    expect(messages.length).toBe(4);
    for (const message of messages) expect(message).not.toContain(TEST_KEY);
  });
});
