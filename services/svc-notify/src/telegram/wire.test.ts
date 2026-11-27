/**
 * The Telegram desk's outside parts: the bot send throws unless the bot API took the message, no token means off; the
 * webhook secret must match exactly; svc-trade's client answers `unavailable`, never an empty desk, on any failure.
 */
import { describe, expect, it } from 'vitest';
import { createTradeDeskClient, telegramTransportFromToken, webhookSecretMatches } from './wire.js';

const SECRET = 's'.repeat(40);

describe('the bot send', () => {
  it('no token is no transport: the channel is off', () => {
    expect(telegramTransportFromToken(undefined)).toBeNull();
    expect(telegramTransportFromToken('  ')).toBeNull();
  });

  it('posts sendMessage with the chat and text, and throws when the bot API did not take it', async () => {
    const calls: { url: string; body: unknown; redirect: unknown }[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), redirect: init?.redirect });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    };
    const t = telegramTransportFromToken('123:abc', { fetcher, base: 'https://bot.test' });
    if (!t) throw new Error('a token makes a transport');
    await t.send('700100', 'hello');
    expect(calls[0]).toEqual({
      url: 'https://bot.test/bot123:abc/sendMessage',
      body: { chat_id: '700100', text: 'hello', disable_web_page_preview: true },
      redirect: 'error',
    });
    answer = { status: 200, body: { ok: false } };
    await expect(t.send('700100', 'x')).rejects.toThrow(/did not take/);
    answer = { status: 429, body: { ok: false } };
    await expect(t.send('700100', 'x')).rejects.toThrow(/429/);
  });
});

describe('the webhook secret', () => {
  it('matches only the configured secret, and a missing or short configured secret refuses everything', () => {
    expect(webhookSecretMatches(SECRET, SECRET)).toBe(true);
    expect(webhookSecretMatches(SECRET, `${SECRET.slice(0, -1)}t`)).toBe(false);
    expect(webhookSecretMatches(SECRET, undefined)).toBe(false);
    expect(webhookSecretMatches(undefined, '')).toBe(false);
    expect(webhookSecretMatches('short', 'short')).toBe(false);
  });
});

describe("svc-trade's desk client", () => {
  const input = { userId: 'u1', since: '2026-11-23T00:00:00.000Z' };

  it('no URL or a short secret reads nothing', async () => {
    expect(await createTradeDeskClient({ secret: SECRET }).read(input)).toEqual({
      state: 'unavailable',
      code: 'trade.desk_snapshot_unavailable',
    });
    expect(await createTradeDeskClient({ tradeUrl: 'http://trade.test', secret: 'short' }).read(input)).toMatchObject({
      state: 'unavailable',
    });
  });

  it('a signed POST to venue.deskSnapshot; a 503 or a reply that breaks the record is unavailable', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    let reply: { status: number; body: unknown } = { status: 200, body: { result: { data: { state: 'off' } } } };
    const fetcher: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    };
    const client = createTradeDeskClient({ tradeUrl: 'http://trade.test/', secret: SECRET, fetcher });
    expect(await client.read(input)).toEqual({ state: 'off' });
    expect(seen[0]?.url).toBe('http://trade.test/trpc/venue.deskSnapshot');
    expect([...(seen[0]?.headers.keys() ?? [])].some((h) => h.startsWith('x-'))).toBe(true);
    reply = { status: 503, body: {} };
    expect(await client.read(input)).toMatchObject({ state: 'unavailable' });
    reply = { status: 200, body: { result: { data: { state: 'read', accounts: 'none' } } } };
    expect(await client.read(input)).toMatchObject({ state: 'unavailable' });
  });
});
