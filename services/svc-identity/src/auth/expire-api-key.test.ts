import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import { AuthError } from './auth-service.js';
import type { ApiKeyFactorGate } from './api-key-fresh-factor.js';
import { apiKeyExpired, expireApiKey, expiryNarrows, requireExpiresAt } from './expire-api-key.js';

/** Each query answers the next queued row set; the texts are kept so a test can say what reached storage. */
function fakeSql(...answers: unknown[][]) {
  const texts: string[] = [];
  const fn = async (strings: TemplateStringsArray) => {
    texts.push(strings.join('?'));
    return answers.shift() ?? [];
  };
  return { sql: fn as unknown as Parameters<typeof expireApiKey>[0]['sql'], texts };
}

/** A gate that refuses without a proof and runs the change with one, as the live gate does. */
function gate(sql: unknown, calls: string[] = []): ApiKeyFactorGate {
  return {
    async withApiKeyAction(input, run) {
      calls.push(input.action);
      if (!input.proof) throw new AuthError('A fresh confirmation is required. Confirm again.', 'auth.step_up_required');
      return run({ tx: sql as never, createApiKey: () => Promise.reject(new Error('no')), revokeApiKey: () => Promise.resolve(false) });
    },
  };
}

const person = { userId: 'u', sid: 's' };
const past = new Date('2000-01-01T00:00:00.000Z');
const soon = new Date('2098-01-01T00:00:00.000Z');
const future = new Date('2099-01-01T00:00:00.000Z');
const now = () => new Date('2026-10-29T00:00:00.000Z');

describe('expireApiKey', () => {
  it('refuses a missing expiresAt and does not read or write', async () => {
    const { sql, texts } = fakeSql();
    for (const missing of [undefined, '']) {
      await expect(expireApiKey({ sql, gate: gate(sql), now }, person, 'k', missing)).rejects.toMatchObject({
        code: 'auth.expires_at_missing',
      });
    }
    expect(() => requireExpiresAt(null)).toThrow(/expiresAt is required/);
    expect(texts).toEqual([]);
  });

  it('an earlier end date, or a first one, narrows and saves with no factor', async () => {
    for (const current of [future, null]) {
      const { sql, texts } = fakeSql([{ revoked: false, expires_at: current }], [{ id: 'k', expires_at: soon }]);
      const calls: string[] = [];
      await expect(expireApiKey({ sql, gate: gate(sql, calls), now }, person, 'k', soon)).resolves.toEqual({ id: 'k', expiresAt: soon });
      expect(calls).toEqual([]);
      expect(texts[0]).toMatch(/FOR UPDATE/);
    }
  });

  it('a later end date needs a fresh factor: refused without one, saved with one, audited as expiry_widen', async () => {
    const refused = fakeSql([{ revoked: false, expires_at: soon }]);
    await expect(expireApiKey({ sql: refused.sql, gate: gate(refused.sql), now }, person, 'k', future)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('[auth.step_up_required]'),
    });
    expect(refused.texts.some((text) => /^\s*UPDATE/.test(text))).toBe(false);

    const calls: string[] = [];
    const ok = fakeSql([{ revoked: false, expires_at: soon }], [{ revoked: false, expires_at: soon }], [{ id: 'k', expires_at: future }]);
    await expect(expireApiKey({ sql: ok.sql, gate: gate(ok.sql, calls), now }, person, 'k', future, { proofId: 'p' })).resolves.toEqual({
      id: 'k',
      expiresAt: future,
    });
    expect(calls).toEqual(['expiry_widen']);
  });

  it('never brings back a revoked or ended key, with or without a factor', async () => {
    for (const row of [
      { revoked: true, expires_at: null },
      { revoked: false, expires_at: past },
    ]) {
      const { sql, texts } = fakeSql([row]);
      await expect(expireApiKey({ sql, gate: gate(sql), now }, person, 'k', future, { proofId: 'p' })).rejects.toMatchObject({
        code: 'identity.key_not_live',
      });
      expect(texts.some((text) => /^\s*UPDATE/.test(text))).toBe(false);
    }
  });

  it('treats a missing key as not found', async () => {
    const { sql } = fakeSql([]);
    await expect(expireApiKey({ sql, gate: gate(sql), now }, person, 'k', future)).rejects.toMatchObject({ code: 'auth.not_found' });
  });

  it('refuses an API key or a sub-account before reading', async () => {
    const { sql, texts } = fakeSql();
    for (const caller of [
      { ...person, kid: 'k' },
      { ...person, sub_account: 'a' },
    ]) {
      await expect(expireApiKey({ sql, gate: gate(sql), now }, caller, 'k', soon)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(texts).toEqual([]);
  });

  it('narrows when the new end is no later than the current one; no end date counts as forever', () => {
    expect(expiryNarrows(null, future)).toBe(true);
    expect(expiryNarrows(future, future)).toBe(true);
    expect(expiryNarrows(soon, future)).toBe(false);
  });

  it('after expiresAt the key cannot place; before it can', async () => {
    expect(apiKeyExpired(past)).toBe(true);
    const expiredDoor = new PlaceDoor(fakeSql([{ id: 'k', user_id: 'u', revoked: false, expires_at: past }]).sql as never);
    await expect(expiredDoor.assertApiKeyLive('k')).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
    const liveDoor = new PlaceDoor(fakeSql([{ id: 'k', user_id: 'u', revoked: false, expires_at: future }]).sql as never);
    await expect(liveDoor.assertApiKeyLive('k')).resolves.toEqual({ id: 'k', userId: 'u' });
  });
});
