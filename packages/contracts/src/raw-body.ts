import type { ServiceRawBody } from './service-auth.js';

/**
 * RAW REQUEST BYTES, RETAINED (the mechanism L2-6 was deferred for).
 *
 * The original S2S signature covered `service` and a timestamp and not the body,
 * and the reason given was accurate: "Fastify has already parsed and discarded
 * [the raw bytes] by the time the tRPC plugin builds a context." You cannot
 * digest bytes you no longer have.
 *
 * ── What was measured, not assumed ───────────────────────────────────────────
 *
 * Fastify 5.10.0, probed directly before this was written:
 *
 *   · `addContentTypeParser('application/json', { parseAs: 'buffer' }, …)`
 *     **overrides the built-in JSON parser without a prior
 *     `removeContentTypeParser`.** Worth checking, because Fastify throws
 *     `FST_ERR_CTP_ALREADY_PRESENT` for a duplicate parser in other cases and
 *     the safe-looking `remove`-then-`add` would itself throw once anything else
 *     had already replaced the parser.
 *   · `parseAs: 'buffer'` hands over the wire bytes **verbatim** — key order,
 *     runs of whitespace, and multi-byte characters all survive (a body with
 *     `café` arrived as 49 bytes for 48 characters, and re-encoded identically).
 *     This is what makes digesting sound; `JSON.stringify(req.body)` would not
 *     be, since neither key order nor whitespace is canonical.
 *   · A `; charset=utf-8` parameter on the content type still routes to the
 *     `application/json` parser, so a caller adding one does not slip past.
 *   · A bodyless request — `GET`, or `POST` with no content-type — **never
 *     invokes a content-type parser at all**, while an `onRequest` hook always
 *     runs. That asymmetry is the entire reason for the `onRequest` marker
 *     below: without it, "this request had no body" and "this service never kept
 *     the bytes" are the same observation, and they must not be.
 *
 * ── Behaviour this deliberately preserves ────────────────────────────────────
 *
 * Replacing the JSON parser means owning its error cases. Fastify's default
 * answers 400 with `FST_ERR_CTP_EMPTY_JSON_BODY` for an empty body and 400 with
 * `FST_ERR_CTP_INVALID_JSON_BODY` for malformed JSON, so the parser below
 * reproduces both — status **and** `code`, because a caller or a log filter may
 * be matching on either. A silent change from 400 to 500 on the money path
 * because a parser was swapped would be a poor trade for a security fix.
 *
 * The default parser is secure-json-parse with proto and constructor poisoning
 * set to `error`. A body that contains `__proto__` or `constructor.prototype`
 * throws, and Fastify catches that throw as the same invalid-JSON 400. The
 * walk below is that check: `JSON.parse` keeps those keys as own properties,
 * and handing the object to the route lets `Object.assign` and similar copies
 * pollute `Object.prototype`.
 *
 * ── Why a WeakMap and not `req.rawBody` ──────────────────────────────────────
 *
 * The common recipe assigns the bytes onto the request object. That works, and
 * costs a global `FastifyRequest` type augmentation that leaks into every package
 * importing Fastify's types, plus a property whose name is a plain string on an
 * object a request handler can otherwise write to. Keying a module-private
 * WeakMap on the request object gives the same lifetime (entries die with the
 * request) with no ambient type change and nothing reachable from outside this
 * module.
 */

const RETAINED = new WeakMap<object, Buffer>();
const RETENTION_ACTIVE = new WeakSet<object>();

const EMPTY = Buffer.alloc(0);

/** Fastify's default content types for JSON bodies. */
const DEFAULT_CONTENT_TYPES = ['application/json'] as const;

type ParserDone = (err: Error | null, body?: unknown) => void;
type HookDone = (err?: Error) => void;

/**
 * The slice of a Fastify instance this needs.
 *
 * Structural rather than `FastifyInstance`, so `@intafaced/contracts` does not
 * take a dependency on `fastify` for two method signatures. A real
 * `FastifyInstance` satisfies it.
 */
export interface RawBodyHost {
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'buffer' },
    handler: (req: object, body: Buffer, done: ParserDone) => void,
  ): unknown;
  addHook(name: 'onRequest', hook: (req: object, reply: unknown, done: HookDone) => void): unknown;
}

function httpError(message: string, code: string): Error {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

const PROTO_KEY = '__proto__';

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * secure-json-parse with `protoAction: 'error'` and `constructorAction: 'error'`.
 * Throws the same `SyntaxError` that parser throws; the caller maps it onto
 * Fastify's invalid-JSON 400 and does not pass the object through.
 */
function assertNoPrototypePoison(value: unknown): void {
  if (value === null || typeof value !== 'object') return;

  const next: object[] = [value];
  while (next.length > 0) {
    const node = next.pop();
    if (node === undefined) continue;

    if (hasOwn(node, PROTO_KEY)) {
      throw new SyntaxError('Object contains forbidden prototype property');
    }

    const ctor = hasOwn(node, 'constructor') ? (node as { constructor?: unknown }).constructor : undefined;
    if (ctor !== null && typeof ctor === 'object' && hasOwn(ctor, 'prototype')) {
      throw new SyntaxError('Object contains forbidden prototype property');
    }

    for (const key in node) {
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') next.push(child);
    }
  }
}

/**
 * Keep the exact bytes of every JSON request on `app`, so an S2S verifier can
 * check them against a signed digest.
 *
 * Call this ONCE, on the same instance whose requests will be verified, and
 * before the routes that need it. Then read the bytes with `rawBodyOf(req)` and
 * hand the result to `verifyServiceHeaders(…, { rawBody })`.
 *
 * Installing this is what lets a service be flipped to `require`. A service that
 * requires body binding without it rejects every caller with `body-unavailable`
 * — loudly, and naming this function, because the alternative is accepting
 * unverified bodies while believing otherwise.
 */
export function retainRawBody(app: RawBodyHost, contentTypes: readonly string[] = DEFAULT_CONTENT_TYPES): void {
  // Runs for EVERY request, including the bodyless ones no parser ever sees.
  // This is what distinguishes "no body" from "we never looked".
  app.addHook('onRequest', (req, _reply, done) => {
    RETENTION_ACTIVE.add(req);
    done();
  });

  for (const contentType of contentTypes) {
    app.addContentTypeParser(contentType, { parseAs: 'buffer' }, (req, body, done) => {
      // Retain BEFORE parsing. A body that fails to parse is still a body that
      // arrived, and a digest mismatch on malformed JSON should be attributable.
      RETAINED.set(req, body);

      if (body.length === 0) {
        done(httpError(`Body cannot be empty when content-type is set to '${contentType}'`, 'FST_ERR_CTP_EMPTY_JSON_BODY'));
        return;
      }

      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        assertNoPrototypePoison(parsed);
        done(null, parsed);
      } catch {
        done(httpError(`Body is not valid JSON but content-type is set to '${contentType}'`, 'FST_ERR_CTP_INVALID_JSON_BODY'));
      }
    });
  }
}

/**
 * Did the request line up for a body? `content-length` other than zero, or any
 * `transfer-encoding`, means bytes followed the headers. A request object with no
 * headers cannot be shown to be bodyless, so it counts as announcing one (fail
 * closed).
 */
function announcesBody(req: object): boolean {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers;
  if (headers === undefined || headers === null) return true;
  if (headers['transfer-encoding'] !== undefined) return true;
  const raw = headers['content-length'];
  if (raw === undefined) return false;
  const length = Array.isArray(raw) ? raw.join(',') : raw;
  return !/^\s*0+\s*$/.test(length);
}

/**
 * The bytes this request carried, if anyone kept them.
 *
 * `{ retained: false }` means `retainRawBody` was never installed on this
 * instance — NOT that the request had no body. A bodyless request on an instance
 * that does retain reports `{ retained: true, bytes: <empty> }`, which verifies
 * against the digest of the empty body.
 *
 * The empty answer is given ONLY to a request that did not announce a body. The
 * `onRequest` marker runs for every request, but a parser that is not ours can
 * still consume the body without calling ours: Fastify's built-in `text/plain`
 * parser on a root route, and the tRPC Fastify plugin, which replaces the JSON
 * parser inside its own scope with `parseAs: 'string'`. Reporting "empty,
 * verified" for those let a replayed empty-body signature authenticate a request
 * carrying an attacker's body. They report `{ retained: false, unread: true }`.
 */
export function rawBodyOf(req: object): ServiceRawBody {
  const bytes = RETAINED.get(req);
  if (bytes !== undefined) return { retained: true, bytes };
  if (RETENTION_ACTIVE.has(req)) return announcesBody(req) ? { retained: false, unread: true } : { retained: true, bytes: EMPTY };
  return { retained: false };
}

/**
 * The bytes to bind for a request that may have reached the handler by either
 * route: `retainRawBody`'s parser (bytes in the WeakMap) or an adapter that
 * keeps the wire text as `req.body` — the tRPC Fastify plugin's `parseAs:
 * 'string'`, or a buffer parser. The string IS what was received, so its UTF-8
 * bytes are the bytes the caller signed; never re-serialise a parsed object.
 */
export function inboundRawBodyOf(req: object & { body?: unknown }): ServiceRawBody {
  if (typeof req.body === 'string') return { retained: true, bytes: Buffer.from(req.body, 'utf8') };
  if (Buffer.isBuffer(req.body)) return { retained: true, bytes: req.body };
  return rawBodyOf(req);
}
