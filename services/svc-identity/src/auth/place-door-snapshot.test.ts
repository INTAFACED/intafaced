import { describe, expect, it } from 'vitest';
import { PlaceDoor } from './place-door.js';
import type { Sql } from 'postgres';

const KEY = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ACC = '00000000-0000-4000-8000-000000000003';
const PAST = new Date('2000-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

function fakeSql(rows: unknown[]): Sql {
  const fn = async () => rows;
  return fn as unknown as Sql;
}

describe('PlaceDoor.getApiKeyOwnership bind snapshot', () => {
  it('empty lists stay empty; unbound account and missing clock omitted; no scopes flatten', async () => {
    const door = new PlaceDoor(
      fakeSql([
        {
          id: KEY,
          user_id: USER,
          revoked: false,
          expires_at: null,
          domain_whitelist: [],
          ip_allowlist: [],
          account_id: null,
          product_scopes: [],
        },
      ]),
    );
    const snap = await door.getApiKeyOwnership(KEY);
    expect(snap).toEqual({
      id: KEY,
      userId: USER,
      revoked: false,
      productScopes: [],
      originAllowlist: [],
      domainWhitelist: [],
      ipAllowlist: [],
      requireSignature: false,
      requireNonEmptyIpAllowlist: false,
    });
    expect(snap && 'accountId' in snap).toBe(false);
    expect(snap && 'expiresAt' in snap).toBe(false);
    expect(snap && 'scopes' in snap).toBe(false);
    expect(snap?.productScopes).not.toContain('trade');
    expect(snap?.originAllowlist).not.toContain('localhost');
  });

  it('publishes stored product/origin/IP/account/expiresAt binds', async () => {
    const door = new PlaceDoor(
      fakeSql([
        {
          id: KEY,
          user_id: USER,
          revoked: false,
          expires_at: FUTURE,
          domain_whitelist: ['app.example.com'],
          ip_allowlist: ['203.0.113.10'],
          account_id: ACC,
          product_scopes: ['trade'],
        },
      ]),
    );
    await expect(door.getApiKeyOwnership(KEY)).resolves.toEqual({
      id: KEY,
      userId: USER,
      revoked: false,
      productScopes: ['trade'],
      originAllowlist: ['app.example.com'],
      domainWhitelist: ['app.example.com'],
      ipAllowlist: ['203.0.113.10'],
      requireSignature: false,
      requireNonEmptyIpAllowlist: false,
      accountId: ACC,
      expiresAt: FUTURE,
    });
  });

  it('revoked and expired keys stay revoked: true; unknown id is null', async () => {
    const revoked = new PlaceDoor(
      fakeSql([
        {
          id: KEY,
          user_id: USER,
          revoked: true,
          expires_at: null,
          domain_whitelist: [],
          ip_allowlist: [],
          account_id: null,
          product_scopes: [],
        },
      ]),
    );
    await expect(revoked.getApiKeyOwnership(KEY)).resolves.toMatchObject({ id: KEY, revoked: true });

    const expired = new PlaceDoor(
      fakeSql([
        {
          id: KEY,
          user_id: USER,
          revoked: false,
          expires_at: PAST,
          domain_whitelist: [],
          ip_allowlist: [],
          account_id: ACC,
          product_scopes: ['trade'],
        },
      ]),
    );
    const snap = await expired.getApiKeyOwnership(KEY);
    expect(snap?.revoked).toBe(true);
    expect(snap?.expiresAt).toEqual(PAST);
    expect(snap?.accountId).toBe(ACC);

    await expect(new PlaceDoor(fakeSql([])).getApiKeyOwnership(KEY)).resolves.toBeNull();
  });
});
