import { describe, expect, it } from 'vitest';
import { inboundRawBodyOf, rawBodyOf, retainRawBody, type RawBodyHost } from './raw-body.js';
import { serviceBodyDigest } from './service-auth.js';

/**
 * These test the tri-state and the parser's contract in isolation.
 *
 * The integration against a REAL Fastify instance lives in
 * `services/svc-ledger/src/s2s-http.test.ts` and
 * `services/svc-matching/src/router.test.ts` — this package has no `fastify`
 * dependency, and the two money-path services are where it actually matters that
 * the bytes being digested are the bytes Fastify received.
 *
 * The host below reproduces Fastify 5's documented call pattern, which was
 * verified by probing Fastify 5.10.0 directly before any of this was written:
 * `parseAs: 'buffer'` hands the parser `(request, payload, done)` with the wire
 * bytes verbatim, and an `onRequest` hook runs for every request including the
 * bodyless ones no parser ever sees.
 */
function fakeHost() {
  let parser: ((req: object, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void) | null = null;
  let hook: ((req: object, reply: unknown, done: (err?: Error) => void) => void) | null = null;

  const host: RawBodyHost = {
    addContentTypeParser(_contentType, _options, handler) {
      parser = handler;
      return undefined;
    },
    addHook(_name, h) {
      hook = h;
      return undefined;
    },
  };

  return {
    host,
    /** Every request runs the hook. Only a request with a body runs the parser. */
    request(body?: string, headers: Record<string, string> = {}) {
      const req = { headers };
      hook?.(req, {}, () => undefined);

      if (body === undefined) return { req, error: null as Error | null, parsed: undefined as unknown };

      let error: Error | null = null;
      let parsed: unknown;
      parser?.(req, Buffer.from(body, 'utf8'), (err, value) => {
        error = err;
        parsed = value;
      });
      return { req, error, parsed };
    },
  };
}

describe('raw body retention — the three states', () => {
  it('reports not-retained for a request nobody kept bytes for', () => {
    // A service that never installed retention. This must NOT look like "no body":
    // under `require` it has to fail closed, because nothing verified anything.
    expect(rawBodyOf({})).toEqual({ retained: false });
  });

  it('reports an empty body as retained, not as absent', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    // A GET, or a POST with no content-type — the parser never runs, the hook does.
    const { req } = request();

    const raw = rawBodyOf(req);
    expect(raw.retained).toBe(true);
    expect(raw.retained && raw.bytes.length).toBe(0);
    // And it verifies against the digest a bodyless caller would have signed.
    expect(raw.retained && serviceBodyDigest(raw.bytes)).toBe(serviceBodyDigest(''));
  });

  it('reports the exact bytes a request carried', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    // Key order, a double space, and a multi-byte character: 48 characters, 49 bytes.
    const body = '{"b":1,"a":"café  x","n":"1.000000000000000001"}';
    const { req, parsed } = request(body);

    const raw = rawBodyOf(req);
    expect(raw.retained && raw.bytes.toString('utf8')).toBe(body);
    expect(raw.retained && raw.bytes.length).toBe(49);
    expect(raw.retained && serviceBodyDigest(raw.bytes)).toBe(serviceBodyDigest(body));
    // The route still gets its parsed body.
    expect(parsed).toEqual({ b: 1, a: 'café  x', n: '1.000000000000000001' });
  });

  it('keeps each request separate', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    const a = request('{"a":1}');
    const b = request('{"b":2}');

    expect(rawBodyOf(a.req).retained && rawBodyOf(a.req).bytes.toString('utf8')).toBe('{"a":1}');
    expect(rawBodyOf(b.req).retained && rawBodyOf(b.req).bytes.toString('utf8')).toBe('{"b":2}');
  });
});

describe('raw body retention — the parser it replaces', () => {
  /**
   * Swapping Fastify's built-in JSON parser means owning its error cases. These
   * are the two answers the default gives, reproduced status AND code, because a
   * silent 400→500 change on the money path would be a poor trade for a security
   * fix.
   */
  it('answers 400 with Fastify’s own code for malformed JSON', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    const { error } = request('{not json');

    expect(error).toBeInstanceOf(Error);
    expect(error as unknown as { statusCode: number }).toMatchObject({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
    });
  });

  it('answers 400 with Fastify’s own code for an empty body', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    const { error } = request('');

    expect(error as unknown as { statusCode: number }).toMatchObject({
      statusCode: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    });
  });

  it('retains the bytes even when they fail to parse', () => {
    // A body that arrived is a body that arrived. Retaining before parsing keeps
    // a digest mismatch on malformed JSON attributable rather than invisible.
    const { host, request } = fakeHost();
    retainRawBody(host);

    const { req } = request('{not json');

    expect(rawBodyOf(req).retained && rawBodyOf(req).bytes.toString('utf8')).toBe('{not json');
  });

  /**
   * Fastify's default parser is secure-json-parse with proto and constructor
   * poisoning set to error. That throw is caught and answered as invalid JSON:
   * 400, `FST_ERR_CTP_INVALID_JSON_BODY`, and the route is not called.
   */
  it.each([
    '{ "__proto__": { "a": 42 } }',
    '{ "nested": { "__proto__": { "a": 1 } } }',
    '[{ "__proto__": { "a": 1 } }]',
    '{ "a": 5, "b": 6, "\\u005f_proto__": { "x": 7 } }',
  ])('answers 400 and does not pass a body that contains __proto__ (%s)', (body) => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    const { req, error, parsed } = request(body);

    expect(parsed).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });
    const raw = rawBodyOf(req);
    expect(raw.retained && raw.bytes.toString('utf8')).toBe(body);
  });

  it.each([
    '{ "constructor": { "prototype": { "foo": "bar" } } }',
    '{ "b": { "constructor": { "prototype": { "x": 1 } } } }',
    '{ "a": 5, "b": 6, "\\u0063\\u006fnstructor": {"prototype":{"bar":"baz"}} }',
  ])('answers 400 and does not pass a body that contains constructor.prototype (%s)', (body) => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    const { req, error, parsed } = request(body);

    expect(parsed).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });
    const raw = rawBodyOf(req);
    expect(raw.retained && raw.bytes.toString('utf8')).toBe(body);
  });

  it('still parses a normal object whose constructor key is not constructor.prototype', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);

    const body = '{"constructor":{"bar":"baz"},"b":"__proto__","n":null}';
    const { error, parsed } = request(body);

    expect(error).toBeNull();
    expect(parsed).toEqual({ constructor: { bar: 'baz' }, b: '__proto__', n: null });
  });
});

describe('raw body retention — a body that no retaining parser kept', () => {
  it('does not call an announced body empty (tRPC adapter / text-plain parser)', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);
    // Marker ran, our parser did not: someone else's parser consumed the body.
    const { req } = request(undefined, { 'content-length': '41' });
    expect(rawBodyOf(req)).toEqual({ retained: false, unread: true });
  });

  it('treats any transfer-encoding as an announced body', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);
    const { req } = request(undefined, { 'transfer-encoding': 'chunked' });
    expect(rawBodyOf(req)).toEqual({ retained: false, unread: true });
  });

  it('still reports an announced-empty body (content-length 0, or none) as empty', () => {
    const { host, request } = fakeHost();
    retainRawBody(host);
    for (const headers of [{}, { 'content-length': '0' }] as Array<Record<string, string>>) {
      const { req } = request(undefined, headers);
      const raw = rawBodyOf(req);
      expect(raw.retained && raw.bytes.length).toBe(0);
    }
  });

  it('fails closed on a marked request object with no headers', () => {
    const { host } = fakeHost();
    retainRawBody(host);
    // fakeHost().request always supplies headers; build the marker by hand.
    let marker: ((req: object, reply: unknown, done: () => void) => void) | undefined;
    retainRawBody({ addContentTypeParser: () => undefined, addHook: (_n, h) => ((marker = h), undefined) });
    const bare = {};
    marker?.(bare, {}, () => undefined);
    expect(rawBodyOf(bare)).toEqual({ retained: false, unread: true });
  });

  it('inboundRawBodyOf binds the exact wire string an adapter left on req.body', () => {
    const wire = '{"b":1,  "a":"café"}';
    const raw = inboundRawBodyOf({ body: wire });
    expect(raw.retained && raw.bytes.equals(Buffer.from(wire, 'utf8'))).toBe(true);
  });

  it('inboundRawBodyOf binds a buffer body and otherwise defers to rawBodyOf', () => {
    const buf = Buffer.from('xyz');
    expect(inboundRawBodyOf({ body: buf })).toEqual({ retained: true, bytes: buf });
    expect(inboundRawBodyOf({ body: { parsed: true } })).toEqual({ retained: false });
  });
});
