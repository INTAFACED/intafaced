import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MemoryNonceStore,
  REQUEST_SIGN_WINDOW_SECONDS,
  assessRequestSignature,
  canonicalRequest,
  hashBody,
  ipAllowlistSatisfied,
  signRequest,
  signaturesEqual,
  type RequestSignMaterial,
} from './api-key-request-sign.js';

const SECRET = 'ifs_test-signing-secret';
const KEY = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-16T01:00:00.000Z');

function material(overrides: Partial<RequestSignMaterial> & { body?: string } = {}): RequestSignMaterial {
  const body = overrides.body ?? '{"amount":"1.10"}';
  const timestamp = overrides.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  const nonce = overrides.nonce ?? 'nonce-fresh-1';
  const path = overrides.path ?? '/api/pay/v1/payments';
  const method = overrides.method ?? 'POST';
  const bodyHash = overrides.bodyHash ?? hashBody(body);
  const signature = overrides.signature ?? signRequest(SECRET, canonicalRequest({ method, path, timestamp, nonce, bodyHash }));
  return { method, path, timestamp, nonce, bodyHash, signature };
}

function assess(requireSignature: boolean, mat: RequestSignMaterial | null, store: MemoryNonceStore, secret: string | null = SECRET) {
  return assessRequestSignature({
    requireSignature,
    secret,
    material: mat,
    now: NOW,
    keyId: KEY,
    nonceStore: store,
  });
}

describe('inbound API key request signature', () => {
  it('accepts an unsigned call when the key has not opted in', async () => {
    await expect(assess(false, null, new MemoryNonceStore())).resolves.toEqual({ ok: true });
  });

  it('refuses an unsigned call when the key requires a signature', async () => {
    await expect(assess(true, null, new MemoryNonceStore())).resolves.toEqual({ ok: false, reason: 'unsigned' });
    await expect(assess(true, null, new MemoryNonceStore(), null)).resolves.toEqual({ ok: false, reason: 'unsigned' });
  });

  it('refuses a stale timestamp', async () => {
    const stale = material({ timestamp: String(Math.floor(NOW.getTime() / 1000) - REQUEST_SIGN_WINDOW_SECONDS - 1) });
    await expect(assess(true, stale, new MemoryNonceStore())).resolves.toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a tampered body', async () => {
    const signed = material();
    const tampered = { ...signed, bodyHash: hashBody('{"amount":"9.99"}') };
    await expect(assess(true, tampered, new MemoryNonceStore())).resolves.toEqual({ ok: false, reason: 'tampered' });
  });

  it('refuses a replay and accepts the first signed call', async () => {
    const store = new MemoryNonceStore();
    const signed = material();
    await expect(assess(true, signed, store)).resolves.toEqual({ ok: true });
    await expect(assess(true, signed, store)).resolves.toEqual({ ok: false, reason: 'replay' });
  });

  it('forgets nonces once they fall outside the window', () => {
    const store = new MemoryNonceStore();
    expect(store.consume(KEY, 'nonce-old-01', NOW)).toBe(true);
    expect(store.size(NOW)).toBe(1);
    const later = new Date(NOW.getTime() + (REQUEST_SIGN_WINDOW_SECONDS + 1) * 1000);
    expect(store.size(later)).toBe(0);
    expect(store.consume(KEY, 'nonce-old-01', later)).toBe(true);
  });

  it('keeps a nonce signed 240s ahead until the signature itself is stale', () => {
    const store = new MemoryNonceStore();
    const signedAt = new Date(NOW.getTime() + 240_000);
    expect(store.consume(KEY, 'nonce-skew-01', NOW, signedAt)).toBe(true);
    for (const delta of [301, 400, 540]) {
      const later = new Date(NOW.getTime() + delta * 1000);
      expect(store.consume(KEY, 'nonce-skew-01', later, signedAt)).toBe(false);
    }
    const after = new Date(NOW.getTime() + 541_000);
    expect(store.size(after)).toBe(0);
    expect(store.consume(KEY, 'nonce-skew-01', after, signedAt)).toBe(true);
  });

  it('compares signatures in constant time and does not throw on a short signature', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'api-key-request-sign.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual');
    expect(src).not.toMatch(/signature\s*===/);
    expect(src).not.toMatch(/=== expected/);
    expect(signaturesEqual('ab', signRequest(SECRET, 'canonical'))).toBe(false);
    expect(signaturesEqual(signRequest(SECRET, 'canonical'), signRequest(SECRET, 'canonical'))).toBe(true);
  });

  it('requires a non-empty IP allowlist only when the key opts in', () => {
    expect(ipAllowlistSatisfied(false, [])).toBe(true);
    expect(ipAllowlistSatisfied(false, undefined)).toBe(true);
    expect(ipAllowlistSatisfied(true, [])).toBe(false);
    expect(ipAllowlistSatisfied(true, ['   '])).toBe(false);
    expect(ipAllowlistSatisfied(true, ['0.0.0.0/0'])).toBe(false);
    expect(ipAllowlistSatisfied(true, ['::/0'])).toBe(false);
    expect(ipAllowlistSatisfied(true, ['0.0.0.0/0', '::/0'])).toBe(false);
    expect(ipAllowlistSatisfied(true, ['203.0.113.10'])).toBe(true);
    expect(ipAllowlistSatisfied(true, ['0.0.0.0/0', '203.0.113.10'])).toBe(true);
  });
});
