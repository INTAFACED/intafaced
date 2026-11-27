import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import {
  ACCOUNT_CALL_MSG,
  VENUE_REFUSAL_TEXT_MAX,
  accountCallLine,
  registerAccountCallLog,
  rememberCaller,
  venueRefusalText,
} from './account-call-log.js';

const person = { userId: '7d1f2c3a-0000-4000-8000-000000000001' };
const venueRefusal = JSON.stringify({
  code: 'InvalidOrder',
  message: 'Insufficient margin to place order. asset=3',
  intafacedCode: 'trade.venue.rejected',
  refusal: { code: 'rejected', detail: 'Insufficient margin to place order. asset=3' },
});

describe('account call line', () => {
  it('names a signed-in call by account id, path without its query, status and no code on a success', () => {
    expect(
      accountCallLine({ principal: person, method: 'get', url: '/api/v1/venue/deposits?owner=0xabc', status: 200, payload: '{}' }),
    ).toEqual({ accountId: person.userId, viaKey: false, method: 'GET', path: '/api/v1/venue/deposits', status: 200, code: null });
  });

  it('carries the venue refusal words and its typed code', () => {
    expect(accountCallLine({ principal: person, method: 'POST', url: '/api/v1/venue/submit', status: 422, payload: venueRefusal })).toEqual(
      {
        accountId: person.userId,
        viaKey: false,
        method: 'POST',
        path: '/api/v1/venue/submit',
        status: 422,
        code: 'trade.venue.rejected',
        refusal: 'Insufficient margin to place order. asset=3',
      },
    );
  });

  it('keeps no words of a refusal outside the venue, and none of a venue success', () => {
    const body = JSON.stringify({ code: 'bank.refused', message: 'secret-ish words' });
    expect(accountCallLine({ principal: person, method: 'POST', url: '/api/bank/trpc/x', status: 403, payload: body })).not.toHaveProperty(
      'refusal',
    );
    expect(venueRefusalText('/api/v1/venue/submit', 200, venueRefusal)).toBeNull();
    expect(venueRefusalText('/api/v1/venues-other', 422, venueRefusal)).toBeNull();
  });

  it('cuts long refusal words and reads a Buffer body', () => {
    const long = JSON.stringify({ message: `x${' y'.repeat(400)}` });
    const text = venueRefusalText('/api/v1/venue/prepare', 422, Buffer.from(long));
    expect(text?.length).toBe(VENUE_REFUSAL_TEXT_MAX);
  });

  it('writes nothing for an anonymous call, and marks a call through an API key', () => {
    expect(accountCallLine({ principal: null, method: 'GET', url: '/api/v1/markets', status: 200, payload: '[]' })).toBeNull();
    expect(accountCallLine({ principal: { userId: '' }, method: 'GET', url: '/api/v1/markets', status: 200, payload: '[]' })).toBeNull();
    expect(
      accountCallLine({ principal: { ...person, kid: 'k1' }, method: 'GET', url: '/api/v1/markets', status: 200, payload: '[]' })?.viaKey,
    ).toBe(true);
  });

  it('is logged once a remembered person is answered, and never for an anonymous call', async () => {
    let raw = '';
    const stream = new Writable({
      write(chunk, _enc, done) {
        raw += String(chunk);
        done();
      },
    });
    const app = Fastify({ logger: { level: 'info', stream } });
    registerAccountCallLog(app);
    app.post('/api/v1/venue/submit', async (req, reply) => {
      rememberCaller(req, person);
      return reply.code(422).header('content-type', 'application/json').send(venueRefusal);
    });
    app.get('/api/v1/markets', async (req) => {
      rememberCaller(req, null);
      return [];
    });
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/venue/submit' });
      expect(res.statusCode).toBe(422);
      expect(res.body).toBe(venueRefusal);
      await app.inject({ method: 'GET', url: '/api/v1/markets' });
    } finally {
      await app.close();
    }
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === ACCOUNT_CALL_MSG);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      accountId: person.userId,
      path: '/api/v1/venue/submit',
      status: 422,
      code: 'trade.venue.rejected',
      refusal: 'Insufficient margin to place order. asset=3',
    });
  });
});
