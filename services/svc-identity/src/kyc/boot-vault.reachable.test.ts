/**
 * CAN ANYBODY ACTUALLY CALL THE KYC VAULT FROM PRODUCTION BOOT?
 *
 * `boot-vault.test.ts` proves the helper. `router.test.ts` proves authority when
 * a test injects `kycDocs`. Neither proves `index.ts` spreads the helper — the
 * gap this mountain named: procedures existed, the key parsed, and production
 * still ran with vault null.
 *
 * This file is the gate. It:
 *   1. Source-scans index.ts for `bootKycVault(sql, env.IDENTITY_KYC_DOC_KEY)`
 *      and `...(vault ?? {})` (fails if the composition root omits the wire).
 *   2. Builds the router the same way index.ts does: `bootKycVault` then spread.
 *      Key set → store / list / bind / get are not the unwired refuse.
 *      Key missing → named PRECONDITION_FAILED as today.
 *   3. Asserts kyc.status never carries bytes or provider_ref.
 *
 * Does not invent a key. Bytes read is compliance+MFA kyc.getDocument only.
 * Class X vendor webhooks stay unwired.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { createIdentityRouter } from '../router.js';
import type { AuthService, KycRecordView } from '../auth/auth-service.js';
import type { RankService } from '../rank/rank-service.js';
import { bootKycVault } from './boot-vault.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');
const routerSrc = readFileSync(join(here, '../router.ts'), 'utf8');

const authConfig = {
  secret: 'identity-kyc-vault-boot-reachability-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '22222222-2222-4222-8222-222222222222';
const RECORD = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const DOC_ID = '55555555-5555-4555-8555-555555555555';

const codeOf = (err: unknown) => (err as { code?: string }).code;

async function ctx(scopes: string[], opts: { mfa?: boolean; userId?: string } = {}): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId: opts.userId ?? OPERATOR, sessionId: SESSION, scopes, tier: 'full', mfa: opts.mfa ?? true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-vault-boot' };
}

function kycRecord(): KycRecordView {
  return {
    id: RECORD,
    userId: USER,
    tier: 'basic',
    jurisdiction: 'DE',
    providerRef: 'provider-pointer-that-must-not-leak',
    status: 'pending',
    reviewedBy: OPERATOR,
    reviewedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
  };
}

const auth = {
  kycTier: async () => 'none' as const,
  listKycRecords: async () => [kycRecord()],
} as unknown as AuthService;
const rank = {} as RankService;

/** postgres.js tagged-template stand-in — enough for put RETURNING / list SELECT. */
function fakeSql(): Sql {
  const fn = async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (/INSERT/i.test(text)) {
      return [
        {
          id: DOC_ID,
          user_id: USER,
          content_type: 'image/jpeg',
          byte_length: 4,
          stored_by: OPERATOR,
          created_at: new Date('2026-08-16T00:00:00.000Z'),
        },
      ];
    }
    return [];
  };
  return fn as unknown as Sql;
}

/** Exact production fragment: helper + spread. Omitting the spread is the silent-dark store. */
function productionRouter(keyMaterial: string | undefined, sql: Sql = fakeSql()) {
  const vault = bootKycVault(sql, keyMaterial);
  return createIdentityRouter(auth, rank, { registrationOpen: true, ...(vault ?? {}) });
}

describe('index.ts production-wires bootKycVault (fails if the spread is omitted)', () => {
  it('calls bootKycVault(sql, env.IDENTITY_KYC_DOC_KEY) and spreads vault into createIdentityRouter', () => {
    expect(indexSrc).toMatch(/bootKycVault\(\s*sql\s*,\s*env\.IDENTITY_KYC_DOC_KEY\s*\)/);
    const routerCall = indexSrc.slice(indexSrc.indexOf('createIdentityRouter('));
    const optsBlock = routerCall.slice(0, routerCall.indexOf('});') + 2);
    expect(optsBlock).toMatch(/\.\.\.\s*\(vault\s*\?\?\s*\{\}\)/);
    expect(indexSrc).not.toMatch(/IDENTITY_KYC_DOC_KEY\s*\|\|/);
    expect(indexSrc).not.toMatch(/randomBytes\(32\)/);
  });
});

describe('production boot shape — missing key refuses named, never invents a vault', () => {
  it('store / list / bind / get refuse PRECONDITION_FAILED when the key is unset', async () => {
    const r = productionRouter(undefined);
    const op = r.createCaller(await ctx(['admin:compliance'], { mfa: true }));
    const store = await op.kyc
      .storeDocument({ userId: USER, contentType: 'image/jpeg', bytesBase64: Buffer.from('scan').toString('base64') })
      .catch((e: unknown) => e);
    const list = await op.kyc.listDocuments({ userId: USER }).catch((e: unknown) => e);
    const bind = await op.kyc.bindDocument({ recordId: RECORD, documentId: DOC_ID }).catch((e: unknown) => e);
    const get = await op.kyc.getDocument({ documentId: DOC_ID }).catch((e: unknown) => e);
    expect(codeOf(store)).toBe('PRECONDITION_FAILED');
    expect(String((store as Error).message)).toMatch(/kyc_doc\.unwired/);
    expect(codeOf(list)).toBe('PRECONDITION_FAILED');
    expect(codeOf(bind)).toBe('PRECONDITION_FAILED');
    expect(codeOf(get)).toBe('PRECONDITION_FAILED');
    expect(String((get as Error).message)).toMatch(/kyc_doc\.unwired/);
  });
});

describe('production boot shape — parsed key exposes operator vault procedures', () => {
  it('store / list / bind / get are not the unwired refuse', async () => {
    const r = productionRouter(randomBytes(32).toString('base64'));
    const op = r.createCaller(await ctx(['admin:compliance'], { mfa: true }));

    const meta = await op.kyc.storeDocument({
      userId: USER,
      contentType: 'image/jpeg',
      bytesBase64: Buffer.from('scan').toString('base64'),
    });
    expect(meta.id).toBe(DOC_ID);
    expect(meta.userId).toBe(USER);
    expect(meta).not.toHaveProperty('bytes');
    expect(meta).not.toHaveProperty('ciphertext');

    const list = await op.kyc.listDocuments({ userId: USER });
    expect(Array.isArray(list)).toBe(true);
    for (const row of list) {
      expect(row).not.toHaveProperty('bytes');
    }

    const bindErr = await op.kyc.bindDocument({ recordId: RECORD, documentId: DOC_ID }).catch((e: unknown) => e);
    expect(codeOf(bindErr)).not.toBe('PRECONDITION_FAILED');
    expect(String((bindErr as Error).message ?? bindErr)).not.toMatch(/kyc_doc\.unwired/);

    const getErr = await op.kyc.getDocument({ documentId: DOC_ID }).catch((e: unknown) => e);
    expect(codeOf(getErr)).not.toBe('PRECONDITION_FAILED');
    expect(String((getErr as Error).message ?? getErr)).not.toMatch(/kyc_doc\.unwired/);
  });
});

describe('kyc.status never returns document bytes or provider_ref', () => {
  it('status payload omits providerRef, reviewedBy, and any bytes field', async () => {
    const r = productionRouter(randomBytes(32).toString('base64'));
    const user = r.createCaller(await ctx(['identity:read'], { userId: USER }));
    const status = await user.kyc.status();
    const wire = JSON.stringify(status);
    expect(wire).not.toContain('provider-pointer-that-must-not-leak');
    expect(status.records[0]).not.toHaveProperty('providerRef');
    expect(status.records[0]).not.toHaveProperty('reviewedBy');
    expect(status.records[0]).not.toHaveProperty('bytes');
    expect(wire).not.toMatch(/"bytes"|"ciphertext"|"bytesBase64"/);
  });

  it('bytes read is compliance getDocument only — kyc.status stays meta', () => {
    expect(routerSrc).toMatch(/getDocument:\s*scopedProcedure\('admin:compliance'\)/);
    expect(routerSrc).toContain('vault.getFor');
    expect(routerSrc).toContain('storeDocument');
    expect(routerSrc).toContain('listDocuments');
    expect(routerSrc).toContain('bindDocument');
    expect(routerSrc).not.toMatch(/readDocument|downloadDocument/);
  });
});
