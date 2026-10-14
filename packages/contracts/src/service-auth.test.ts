import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_SERVICE_BODY_BIND_MODE,
  SERVICE_BODY_DIGEST_HEADER,
  SERVICE_CALL_MAX_SKEW_SECONDS,
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SERVICE_TIMESTAMP_HEADER,
  ServiceAuthError,
  requireServiceCaller,
  serviceAuthHeaders,
  serviceAuthHeadersForBody,
  serviceBodyDigest,
  serviceCallPreimage,
  signServiceCall,
  signServiceCallWithBody,
  verifyServiceCall,
  verifyServiceHeaders,
  type ServiceRawBody,
} from './service-auth.js';

const SECRET = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

const nowSec = () => Math.floor(Date.now() / 1000);

/** A real request body, as a client would serialise it. */
const BODY = JSON.stringify({
  idempotencyKey: 'k-1',
  module: 'trade',
  entries: [
    { account: 'user:available', direction: 'debit', amount: '10.000000000000000001' },
    { account: 'hold:order', direction: 'credit', amount: '10.000000000000000001' },
  ],
});

const bytes = (body: string): ServiceRawBody => ({ retained: true, bytes: Buffer.from(body, 'utf8') });
const NOT_RETAINED: ServiceRawBody = { retained: false };

describe('service credentials — the happy path', () => {
  it('accepts v2 headers produced by the matching secret, over the exact body', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);

    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(BODY), mode: 'require' })).toEqual({
      service: 'svc-trade',
      rejected: null,
      scheme: 'v2',
    });
  });

  it('names the calling service, so the ledger knows who posted', () => {
    for (const svc of ['svc-trade', 'svc-pay', 'svc-p2p', 'svc-token', 'svc-bank', 'svc-agents']) {
      const headers = serviceAuthHeadersForBody(svc, SECRET, BODY);
      expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(BODY), mode: 'require' }).service).toBe(svc);
    }
  });

  it('binds a bodyless call as the empty body, not as an absent field', () => {
    // A GET or a bodyless POST still signs a digest — of nothing. So "there is no
    // body" is a signed statement and a body cannot be added to the call.
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, '');

    expect(headers[SERVICE_BODY_DIGEST_HEADER]).toBe(serviceBodyDigest(''));
    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(''), mode: 'require' }).scheme).toBe('v2');

    // And the attack that would otherwise be free: bolt a body onto a bodyless call.
    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes('{"amount":"1000000"}'), mode: 'require' })).toEqual({
      service: null,
      rejected: 'body-mismatch',
      scheme: null,
    });
  });
});

// ── L2-6: the body is in the signature ───────────────────────────────────────
//
// The hole this closes, quoting the header comment it replaces: the signature
// covered `service` and a timestamp, so "within the 300-second skew window, a
// captured signature is replayable against any body and any procedure on that
// service". svc-ledger's `/trpc/post` and svc-matching's order writes are S2S
// surfaces, so that was a replayable money instruction.

describe('service credentials — body binding (L2-6)', () => {
  /** THE TEST THIS WHOLE CHANGE EXISTS FOR. */
  it('refuses a valid signature replayed over a mutated body', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);

    // Byte-for-byte the credentials that just worked, against a different
    // transaction. This is the capture-and-replay the old scheme permitted.
    const tampered = BODY.replace('10.000000000000000001', '99999.000000000000000001');
    expect(tampered).not.toBe(BODY);

    for (const mode of ['accept-both', 'require'] as const) {
      expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(tampered), mode })).toEqual({
        service: null,
        rejected: 'body-mismatch',
        scheme: null,
      });
    }
  });

  it('refuses a body mutated by a single byte, and by reordered keys', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, '{"a":1,"b":2}');

    for (const mutation of ['{"a":2,"b":2}', '{"b":2,"a":1}', '{"a":1,"b":2} ', ' {"a":1,"b":2}', '{"a":1,"b":20}']) {
      expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(mutation), mode: 'require' }).rejected).toBe('body-mismatch');
    }
  });

  it('rejects a mutated body even under accept-both — that is not a config decision', () => {
    // `accept-both` tolerates a caller that has not been redeployed. It does not
    // tolerate bytes that disagree with a signature we can actually check.
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);

    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes('{}'), mode: 'accept-both' }).service).toBeNull();
  });

  it('refuses a digest header swapped for one the signature does not cover', () => {
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);
    const swapped = { ...headers, [SERVICE_BODY_DIGEST_HEADER]: serviceBodyDigest('{}') };

    // The digest is inside the signed preimage, so rewriting it to match a
    // substituted body breaks the signature rather than the binding check.
    expect(verifyServiceHeaders(swapped, SECRET, { rawBody: bytes('{}'), mode: 'require' })).toEqual({
      service: null,
      rejected: 'bad-signature',
      scheme: null,
    });
  });

  it('refuses a malformed digest header without throwing', () => {
    const ts = nowSec();
    const digest = serviceBodyDigest(BODY);
    const sig = signServiceCallWithBody('svc-trade', SECRET, ts, digest);

    for (const bad of ['', 'zz', digest.toUpperCase(), digest.slice(0, 63), `${digest}0`, 'not-a-digest']) {
      const call = () =>
        verifyServiceCall('svc-trade', String(ts), sig, SECRET, { bodyDigest: bad, rawBody: bytes(BODY), mode: 'require' });
      expect(call).not.toThrow();
      expect(call().service).toBeNull();
    }
  });

  it('digests the raw bytes, so a multi-byte body is not silently mismeasured', () => {
    // 48 characters, 49 bytes. A char-length or re-serialised digest gets this wrong.
    const body = '{"b":1,"a":"café  x","n":"1.000000000000000001"}';
    expect(Buffer.byteLength(body, 'utf8')).not.toBe(body.length);

    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, body);
    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(body), mode: 'require' }).scheme).toBe('v2');
  });

  it('signs a Buffer and a string body identically', () => {
    // The caller may hold either. They must not produce different signatures.
    expect(serviceBodyDigest(BODY)).toBe(serviceBodyDigest(Buffer.from(BODY, 'utf8')));
  });
});

// ── The canonical string ─────────────────────────────────────────────────────

describe('service credentials — canonical framing', () => {
  it('length-prefixes every field, so no field content can be read as a delimiter', () => {
    const digest = serviceBodyDigest('');
    expect(serviceCallPreimage('svc-trade', 1, digest)).toBe(`intafaced-s2s-v2\n9:svc-trade\n1:1\n64:${digest}\n`);
  });

  it('cannot be forged by splitting a delimiter between fields', () => {
    // v1's original property, preserved: ('ab', 1) and ('a', 11) must not collide.
    expect(signServiceCall('ab', SECRET, 1)).not.toBe(signServiceCall('a', SECRET, 11));

    const d = serviceBodyDigest('');
    expect(signServiceCallWithBody('ab', SECRET, 1, d)).not.toBe(signServiceCallWithBody('a', SECRET, 11, d));
  });

  it('is injective even when a service name contains the delimiters and a fake length prefix', () => {
    // A bare-newline join is unambiguous only because the timestamp and digest
    // are validated into narrow shapes elsewhere. Length-prefixing does not need
    // that help, so this holds for adversarial names that impersonate framing.
    const d1 = serviceBodyDigest('one');
    const d2 = serviceBodyDigest('two');

    const triples: Array<[string, number, string]> = [
      ['svc-trade', 1, d1],
      ['svc-trade', 11, d1],
      ['svc-trad', 1, d1],
      ['svc-trade', 1, d2],
      ['svc\ntrade', 1, d1],
      ['svc-trade\n1', 1, d1],
      [`svc\n1\n${d1}`, 1, d1],
      [`9:svc-trade\n1:1\n64:${d1}`, 1, d1],
      ['', 1, d1],
      // Precomposed vs combining accent. These two render identically — four
      // versus five code points, five versus six bytes — so a byte-counted frame
      // keeps them distinct and one cannot be signed while the other is presented.
      ['café', 1, d1],
      ['café', 1, d1],
    ];

    const preimages = triples.map(([s, t, d]) => serviceCallPreimage(s, t, d));
    expect(new Set(preimages).size).toBe(triples.length);
  });

  it('keeps v1 and v2 preimages disjoint, so a signature cannot cross schemes', () => {
    // This is what makes accept-both a migration window and not a second hole.
    const ts = nowSec();
    const digest = serviceBodyDigest(BODY);

    const v1 = signServiceCall('svc-trade', SECRET, ts);
    const v2 = signServiceCallWithBody('svc-trade', SECRET, ts, digest);
    expect(v1).not.toBe(v2);

    // A v1 signature presented as if it were v2 is refused...
    expect(verifyServiceCall('svc-trade', String(ts), v1, SECRET, { bodyDigest: digest, rawBody: bytes(BODY) }).rejected).toBe(
      'bad-signature',
    );

    // ...and a v2 signature presented with the digest header stripped is too.
    expect(verifyServiceCall('svc-trade', String(ts), v2, SECRET, {}).rejected).toBe('bad-signature');
  });
});

// ── Migration: accept-both, then require ─────────────────────────────────────

describe('service credentials — the migration path', () => {
  it('defaults to accept-both, because require would 401 the whole fleet on the first rollout', () => {
    expect(DEFAULT_SERVICE_BODY_BIND_MODE).toBe('accept-both');
  });

  it('accept-both admits a legacy v1 caller that has not been redeployed', () => {
    const legacy = serviceAuthHeaders('svc-trade', SECRET);

    expect(verifyServiceHeaders(legacy, SECRET, { rawBody: bytes(BODY), mode: 'accept-both' })).toEqual({
      service: 'svc-trade',
      rejected: null,
      scheme: 'v1',
    });
  });

  it('accept-both admits a v2 caller as well — both directions, which is the point', () => {
    const modern = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);

    expect(verifyServiceHeaders(modern, SECRET, { rawBody: bytes(BODY), mode: 'accept-both' }).scheme).toBe('v2');
  });

  it('reports the scheme it accepted, which is the signal an operator flips on', () => {
    // "No v1 accepts from any caller for a full window" is the evidence that
    // setting INTERNAL_SERVICE_BODY_BIND=require will not break anything.
    const legacy = verifyServiceHeaders(serviceAuthHeaders('svc-trade', SECRET), SECRET, { rawBody: bytes(BODY) });
    const modern = verifyServiceHeaders(serviceAuthHeadersForBody('svc-trade', SECRET, BODY), SECRET, { rawBody: bytes(BODY) });

    expect(legacy.scheme).toBe('v1');
    expect(modern.scheme).toBe('v2');
  });

  it('require refuses a v1 caller — a missing digest under the new regime', () => {
    const legacy = serviceAuthHeaders('svc-trade', SECRET);

    expect(verifyServiceHeaders(legacy, SECRET, { rawBody: bytes(BODY), mode: 'require' })).toEqual({
      service: null,
      rejected: 'missing-body-digest',
      scheme: null,
    });
  });

  it('names a v1 caller only AFTER its signature verified, never an anonymous prober', () => {
    // `missing-body-digest` must always describe an authenticated service that
    // needs redeploying. Anyone who cannot sign gets the generic answers, so the
    // reason is never a hint about policy to a stranger.
    const ts = String(nowSec());

    expect(verifyServiceCall('svc-trade', ts, 'f'.repeat(64), SECRET, { mode: 'require' }).rejected).toBe('bad-signature');
    expect(verifyServiceCall(undefined, ts, 'f'.repeat(64), SECRET, { mode: 'require' }).rejected).toBe('missing');
    expect(verifyServiceCall('svc-trade', ts, signServiceCall('svc-trade', OTHER, Number(ts)), SECRET, { mode: 'require' }).rejected).toBe(
      'bad-signature',
    );
  });

  it('require fails closed when the verifier never kept the bytes', () => {
    // A v2 caller, an authentic signature, and a service that forgot to install
    // raw-body retention. Accepting here would mean believing a body was verified
    // when nothing looked at it, so `require` refuses and says whose fault it is.
    const modern = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);

    expect(verifyServiceHeaders(modern, SECRET, { rawBody: NOT_RETAINED, mode: 'require' })).toEqual({
      service: null,
      rejected: 'body-unavailable',
      scheme: null,
    });
  });

  it('accept-both still admits a v2 caller when the bytes were not kept', () => {
    // The signature proves the digest header is authentic; only the binding is
    // unproven. That is exactly the pre-L2-6 guarantee, which is what a service
    // mid-migration is entitled to.
    const modern = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);

    expect(verifyServiceHeaders(modern, SECRET, { rawBody: NOT_RETAINED, mode: 'accept-both' }).service).toBe('svc-trade');
  });

  /**
   * THE HONEST LIMIT, as a test rather than a footnote.
   *
   * Under accept-both an active attacker strips the digest header and downgrades
   * a captured v2 call to v1 — except that it does NOT work here, because the two
   * preimages are disjoint, so the captured signature does not verify as v1.
   *
   * What an attacker CAN still do under accept-both is replay a captured *v1*
   * call, from a caller that has not been redeployed. That is the residual risk,
   * and it is why `require` is the destination rather than the default.
   */
  it('cannot downgrade a captured v2 call to v1 by stripping the digest header', () => {
    const modern = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);
    const { [SERVICE_BODY_DIGEST_HEADER]: _stripped, ...downgraded } = modern;

    expect(verifyServiceHeaders(downgraded, SECRET, { rawBody: bytes('{}'), mode: 'accept-both' })).toEqual({
      service: null,
      rejected: 'bad-signature',
      scheme: null,
    });
  });

  it('a captured v1 call IS still replayable under accept-both — the residual risk, stated', () => {
    const legacy = serviceAuthHeaders('svc-trade', SECRET);

    // Any body at all, because v1 signs no body. This is the hole, and the only
    // thing that closes it is flipping the caller to v2 and the verifier to require.
    expect(verifyServiceHeaders(legacy, SECRET, { rawBody: bytes('{"anything":true}'), mode: 'accept-both' }).service).toBe('svc-trade');
    expect(verifyServiceHeaders(legacy, SECRET, { rawBody: bytes('{"anything":true}'), mode: 'require' }).service).toBeNull();
  });
});

describe('service credentials — the attack this closes', () => {
  /**
   * The exact pre-fix exploit: `ledger.post` was `publicProcedure` and every
   * caller sent only `content-type`. A stranger posting the `deposit` recipe
   * mints themselves any balance — it is a well-formed transaction, just
   * unauthorised. With no headers at all, there is now no service.
   */
  it('refuses a caller that sends no credentials at all', () => {
    expect(verifyServiceHeaders({ 'content-type': 'application/json' }, SECRET)).toEqual({
      service: null,
      rejected: 'missing',
      scheme: null,
    });
  });

  /**
   * Added after a mutation test found only one assertion covered it: claiming
   * to BE a service, with no signature offered at all. The cheapest possible
   * forgery — one header — and the suite had no direct test for it.
   */
  it('refuses a caller that claims a service name but sends no signature', () => {
    expect(verifyServiceHeaders({ [SERVICE_HEADER]: 'svc-trade' }, SECRET)).toEqual({
      service: null,
      rejected: 'missing',
      scheme: null,
    });

    expect(verifyServiceHeaders({ [SERVICE_HEADER]: 'svc-trade', [SERVICE_TIMESTAMP_HEADER]: String(nowSec()) }, SECRET)).toEqual({
      service: null,
      rejected: 'missing',
      scheme: null,
    });
  });

  it('refuses a caller that names a service but cannot sign for it', () => {
    expect(
      verifyServiceHeaders(
        {
          [SERVICE_HEADER]: 'svc-trade',
          [SERVICE_TIMESTAMP_HEADER]: String(nowSec()),
          [SERVICE_SIGNATURE_HEADER]: 'f'.repeat(64),
        },
        SECRET,
      ),
    ).toEqual({ service: null, rejected: 'bad-signature', scheme: null });
  });

  it('refuses a signature minted with the wrong secret', () => {
    expect(verifyServiceHeaders(serviceAuthHeadersForBody('svc-trade', OTHER, BODY), SECRET, { rawBody: bytes(BODY) }).service).toBeNull();
    expect(verifyServiceHeaders(serviceAuthHeaders('svc-trade', OTHER), SECRET).service).toBeNull();
  });

  /**
   * Impersonation: a captured svc-agents signature replayed while claiming to
   * be svc-trade. The service name is inside the signed preimage, so the
   * signature does not travel to another identity.
   */
  it('refuses a valid signature reused under a different service name', () => {
    for (const headers of [serviceAuthHeaders('svc-agents', SECRET), serviceAuthHeadersForBody('svc-agents', SECRET, BODY)]) {
      const stolen = { ...headers, [SERVICE_HEADER]: 'svc-trade' };

      expect(verifyServiceHeaders(stolen, SECRET, { rawBody: bytes(BODY) })).toEqual({
        service: null,
        rejected: 'bad-signature',
        scheme: null,
      });
    }
  });

  it('refuses a signature reused under a different timestamp', () => {
    const ts = nowSec();

    for (const headers of [serviceAuthHeaders('svc-trade', SECRET), serviceAuthHeadersForBody('svc-trade', SECRET, BODY)]) {
      expect(
        verifyServiceHeaders({ ...headers, [SERVICE_TIMESTAMP_HEADER]: String(ts + 1) }, SECRET, { rawBody: bytes(BODY) }).service,
      ).toBeNull();
    }
  });

  it('refuses non-hex, empty, truncated and over-long signatures without throwing', () => {
    const ts = nowSec();
    const digest = serviceBodyDigest(BODY);
    const good = signServiceCallWithBody('svc-trade', SECRET, ts, digest);

    for (const bad of ['', 'zz', 'not-hex', good.slice(0, -1), good.slice(0, 32), `${good}00`]) {
      const call = () => verifyServiceCall('svc-trade', String(ts), bad, SECRET, { bodyDigest: digest, rawBody: bytes(BODY) });
      expect(call).not.toThrow();
      expect(call().service).toBeNull();
    }
  });

  it('refuses a non-integer timestamp', () => {
    expect(verifyServiceCall('svc-trade', 'not-a-number', 'ab', SECRET).rejected).toBe('missing');
  });
});

describe('service credentials — a body that was announced but never read', () => {
  const UNREAD: ServiceRawBody = { retained: false, unread: true };

  it('refuses an authentic v2 signature in BOTH modes (it may be the empty digest, replayed)', () => {
    const emptySig = serviceAuthHeadersForBody('svc-edge', SECRET, '');
    for (const mode of ['accept-both', 'require'] as const) {
      expect(verifyServiceHeaders(emptySig, SECRET, { rawBody: UNREAD, mode })).toEqual({
        service: null,
        rejected: 'body-unavailable',
        scheme: null,
      });
    }
  });

  it('still lets accept-both admit an authentic v2 call when retention was never installed', () => {
    const modern = serviceAuthHeadersForBody('svc-trade', SECRET, BODY);
    expect(verifyServiceHeaders(modern, SECRET, { rawBody: NOT_RETAINED, mode: 'accept-both' }).service).toBe('svc-trade');
  });
});

describe('service credentials — replay window', () => {
  it('accepts a call inside the skew window', () => {
    const at = new Date();
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY, { now: at });
    const later = new Date(at.getTime() + (SERVICE_CALL_MAX_SKEW_SECONDS - 1) * 1000);

    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(BODY), mode: 'require', now: later }).service).toBe('svc-trade');
  });

  it('refuses a captured header once the window has passed', () => {
    const at = new Date();
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY, { now: at });
    const later = new Date(at.getTime() + (SERVICE_CALL_MAX_SKEW_SECONDS + 1) * 1000);

    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(BODY), mode: 'require', now: later })).toEqual({
      service: null,
      rejected: 'stale',
      scheme: null,
    });
  });

  it('refuses a header from too far in the future, not just the past', () => {
    const at = new Date();
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY, {
      now: new Date(at.getTime() + (SERVICE_CALL_MAX_SKEW_SECONDS + 1) * 1000),
    });

    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(BODY), now: at }).rejected).toBe('stale');
  });

  it('still refuses a stale call whose body matches perfectly', () => {
    // Body binding does not relax freshness, and the window is unchanged at 300s.
    expect(SERVICE_CALL_MAX_SKEW_SECONDS).toBe(300);

    const at = new Date();
    const headers = serviceAuthHeadersForBody('svc-trade', SECRET, BODY, { now: at });
    const later = new Date(at.getTime() + (SERVICE_CALL_MAX_SKEW_SECONDS + 1) * 1000);

    expect(verifyServiceHeaders(headers, SECRET, { rawBody: bytes(BODY), mode: 'require', now: later }).service).toBeNull();
  });

  it('checks freshness before the signature, so a stale call is not a signature oracle', () => {
    const at = new Date();
    const stale = String(Math.floor(at.getTime() / 1000) - SERVICE_CALL_MAX_SKEW_SECONDS - 1);

    expect(verifyServiceCall('svc-trade', stale, 'f'.repeat(64), SECRET, { now: at }).rejected).toBe('stale');
  });
});

describe('secret strength', () => {
  it('refuses to sign with a weak or absent secret', () => {
    expect(() => signServiceCall('svc-trade', '', 1)).toThrow(ServiceAuthError);
    expect(() => signServiceCall('svc-trade', 'short', 1)).toThrow(/at least 32/);
    expect(() => signServiceCallWithBody('svc-trade', '', 1, serviceBodyDigest(''))).toThrow(ServiceAuthError);
    expect(() => serviceAuthHeadersForBody('svc-trade', 'short', BODY)).toThrow(/at least 32/);
  });
});

describe('requireServiceCaller', () => {
  it('throws UNAUTHORIZED — not FORBIDDEN — when no service identified itself', () => {
    try {
      requireServiceCaller(null);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      // UNAUTHORIZED because the caller has not said who it is. FORBIDDEN would
      // mean "you are known and not allowed", which is a different answer and
      // must stay distinguishable to a caller.
      expect((err as TRPCError).code).toBe('UNAUTHORIZED');
    }
  });

  it('passes a named service through', () => {
    expect(() => requireServiceCaller('svc-trade')).not.toThrow();
  });
});
