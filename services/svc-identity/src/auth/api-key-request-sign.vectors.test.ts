import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assessRequestSignature as identityAssess,
  canonicalRequest as identityCanonical,
  hashBody,
  parseRequestSignWindow,
  requestSigningPolicy,
  signRequest as identitySign,
  type RequestSignMaterial,
} from './api-key-request-sign.js';

/** Loaded at runtime so the identity test project does not pull svc-edge into rootDir. */
const edgeHref = new URL('../../../svc-edge/src/api-key-request-sign.ts', import.meta.url).href;

type EdgeSign = {
  canonicalRequest: typeof identityCanonical;
  signRequest: typeof identitySign;
  assessRequestSignature: typeof identityAssess;
  MemoryNonceStore: new () => { consume(keyId: string, nonce: string, now: Date): boolean };
};

async function loadEdge(): Promise<EdgeSign> {
  return (await import(edgeHref)) as EdgeSign;
}

const SECRET = 'ifs_vector-lock';
const KEY = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-16T01:00:00.000Z');

function material(bodyHash: string, signature: string, nonce = 'nonce-fresh-1'): RequestSignMaterial {
  return {
    method: 'POST',
    path: '/api/pay/v1/payments',
    timestamp: String(Math.floor(NOW.getTime() / 1000)),
    nonce,
    bodyHash,
    signature,
  };
}

describe('identity and edge sign the same canonical request', () => {
  it('matches the edge helper on a fixed vector', async () => {
    const edge = await loadEdge();
    const canonical = identityCanonical({
      method: 'post',
      path: '/api/pay/v1/payments?merchantId=abc',
      timestamp: '1700000000',
      nonce: 'nonce-fresh-1',
      bodyHash: 'ab'.repeat(32),
    });
    expect(canonical).toBe(
      edge.canonicalRequest({
        method: 'post',
        path: '/api/pay/v1/payments?merchantId=abc',
        timestamp: '1700000000',
        nonce: 'nonce-fresh-1',
        bodyHash: 'ab'.repeat(32),
      }),
    );
    expect(identitySign(SECRET, canonical)).toBe(edge.signRequest(SECRET, canonical));
    expect(identitySign(SECRET, canonical)).toBe('d61e9fa131b74a34ffdf69dbeee3fe8b82b68168d54a230d9d7ed12f042b4283');
  });

  it('compares with timingSafeEqual', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'api-key-request-sign.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual');
    expect(src).not.toMatch(/signature\s*===/);
  });

  it('agrees with the edge assessor on unsigned, tamper, stale, and replay', async () => {
    const canonical = identityCanonical({
      method: 'POST',
      path: '/api/pay/v1/payments',
      timestamp: String(Math.floor(NOW.getTime() / 1000)),
      nonce: 'nonce-fresh-1',
      bodyHash: 'cd'.repeat(32),
    });
    const signature = identitySign(SECRET, canonical);
    const good = material('cd'.repeat(32), signature);
    const edge = await loadEdge();
    const store = { consume: () => true };
    const edgeStore = new edge.MemoryNonceStore();
    const input = {
      requireSignature: true,
      secret: SECRET,
      material: good,
      now: NOW,
      keyId: KEY,
      windowSeconds: 300,
    };
    expect(await identityAssess({ ...input, nonceStore: store })).toEqual(
      await edge.assessRequestSignature({ ...input, nonceStore: edgeStore }),
    );
    const staleCanonical = identityCanonical({
      method: 'POST',
      path: '/api/pay/v1/payments',
      timestamp: '1',
      nonce: 'nonce-fresh-1',
      bodyHash: 'cd'.repeat(32),
    });
    const stale = { ...good, timestamp: '1', signature: identitySign(SECRET, staleCanonical) };
    expect(await identityAssess({ ...input, material: stale, nonceStore: store })).toEqual(
      await edge.assessRequestSignature({ ...input, material: stale, nonceStore: new edge.MemoryNonceStore() }),
    );
    const tampered = { ...good, bodyHash: 'ef'.repeat(32) };
    expect(await identityAssess({ ...input, material: tampered, nonceStore: store })).toEqual({ ok: false, reason: 'tampered' });
    expect(await identityAssess({ ...input, material: null, nonceStore: store })).toEqual({ ok: false, reason: 'unsigned' });
    const replayStore = {
      seen: false,
      consume() {
        if (this.seen) return false;
        this.seen = true;
        return true;
      },
    };
    await identityAssess({ ...input, nonceStore: replayStore });
    expect(await identityAssess({ ...input, nonceStore: replayStore })).toEqual({ ok: false, reason: 'replay' });
  });

  it('refuses every signed request while the owner window is blank', async () => {
    const store = { consume: () => true };
    const material0 = material('cd'.repeat(32), '00'.repeat(32));
    expect(
      await identityAssess({
        requireSignature: true,
        secret: SECRET,
        material: material0,
        now: NOW,
        keyId: KEY,
        nonceStore: store,
        windowSeconds: null,
      }),
    ).toEqual({ ok: false, reason: 'window_unset' });
  });

  it('publishes a TEST vector the edge signer reproduces, and the owner window as set', async () => {
    const edge = await loadEdge();
    const policy = requestSigningPolicy(300);
    expect(policy.windowSeconds).toBe(300);
    expect(requestSigningPolicy(null).windowSeconds).toBeNull();
    const v = policy.vector;
    expect(v.secret).toContain('TEST');
    expect(v.bodySha256).toBe(hashBody(v.body));
    const canonical = edge.canonicalRequest({
      method: v.method,
      path: v.path,
      timestamp: v.timestamp,
      nonce: v.nonce,
      bodyHash: v.bodySha256,
    });
    expect(v.canonical).toBe(canonical);
    expect(v.canonical.split('\n')).toEqual(['INTAFACED-REQ-V1', 'POST', v.path, v.timestamp, v.nonce, v.bodySha256]);
    expect(v.signature).toBe(edge.signRequest(v.secret, canonical));
    expect(v.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the owner window as whole seconds, blank as unset, and refuses anything else', () => {
    expect(parseRequestSignWindow(undefined)).toBeNull();
    expect(parseRequestSignWindow('  ')).toBeNull();
    expect(parseRequestSignWindow('300')).toBe(300);
    expect(parseRequestSignWindow('3600')).toBe(3600);
    for (const bad of ['0', '3601', '-5', '1.5', '5m', '1e3']) {
      expect(() => parseRequestSignWindow(bad)).toThrow(/IDENTITY_REQUEST_SIGN_WINDOW_SECONDS/);
    }
  });
});
