/**
 * CAN ANYBODY ACTUALLY CALL THE KYC VAULT FROM PRODUCTION BOOT?
 *
 * `boot-vault.test.ts` proves the helper. `router.test.ts` proves authority when
 * a test injects `kycDocs`. Neither proves `index.ts` spreads the helper — the
 * gap this mountain named: procedures existed, the key parsed, and production
 * still ran with vault null.
 *
 * This file is the gate. It:
 *   1. Boots index.ts (boot.testkit.ts) with and without IDENTITY_KYC_DOC_KEY and
 *      calls the vault doors on the router it serves (fails if the composition
 *      root omits the wire).
 *   2. Builds the router the same way index.ts does: `bootKycVault` then spread.
 *      Key set → store / list / bind / get are not the unwired refuse.
 *      Key missing → named PRECONDITION_FAILED as today.
 *   3. Asserts kyc.status never carries bytes or provider_ref.
 *
 * Does not invent a key. Bytes read is compliance+MFA kyc.getDocument only.
 * Class X vendor webhooks stay unwired.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { createIdentityRouter } from '../router.js';
import { stubActionApprovals } from '../auth/privileged-dual-control.js';
import type { AuthService, KycRecordView } from '../auth/auth-service.js';
import type { RankService } from '../rank/rank-service.js';
import { BOOT_TIMEOUT_MS, bootIdentity, contextWith } from '../boot.testkit.js';
import { KYC_VAULT_UNWIRED, bootKycVault } from './boot-vault.js';
import { IDENTITY_KYC_GET_DOCUMENT, IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';

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
const CONFIRM = '66666666-6666-4666-8666-666666666666';
const bindDual = { approvalId: 'appr-1', operationId: 'op-1' };

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
  kycTradingOnly: async () => false,
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
  return fn as Sql;
}

/** Exact production fragment: helper + spread. Omitting the spread is the silent-dark store. */
function productionRouter(keyMaterial: string | undefined, sql: Sql = fakeSql()) {
  const vault = bootKycVault(sql, keyMaterial);
  return createIdentityRouter(auth, rank, { registrationOpen: true, actionApprovals: stubActionApprovals(), ...(vault ?? {}) });
}

describe('index.ts production-wires bootKycVault (fails if the spread is omitted)', () => {
  it(
    'the booted service opens the vault from IDENTITY_KYC_DOC_KEY and refuses unwired without it',
    async () => {
      const list = async (env: Record<string, string | undefined>) => {
        const { appRouter } = await bootIdentity(env);
        const op = appRouter.createCaller(await contextWith(['admin:compliance'], { userId: OPERATOR, mfa: true }));
        return op.kyc.listDocuments({ userId: USER, limit: 200 }).catch((e: unknown) => e);
      };
      // With the key the router has the vault: the list is not the unwired refusal.
      const keyed = await list({ IDENTITY_KYC_DOC_KEY: randomBytes(32).toString('base64') });
      expect(String((keyed as Error).message ?? '')).not.toContain(KYC_VAULT_UNWIRED);
      // Without it nothing invents a key: the same door refuses named.
      const unkeyed = await list({ IDENTITY_KYC_DOC_KEY: undefined });
      expect(codeOf(unkeyed)).toBe('PRECONDITION_FAILED');
      expect(String((unkeyed as Error).message)).toContain(KYC_VAULT_UNWIRED);
    },
    BOOT_TIMEOUT_MS,
  );
});

describe('production boot shape — missing key refuses named, never invents a vault', () => {
  it('store / list / bind / get refuse PRECONDITION_FAILED when the key is unset', async () => {
    const r = productionRouter(undefined);
    const op = r.createCaller(await ctx(['admin:compliance'], { mfa: true }));
    const store = await op.kyc
      .storeDocument({
        userId: USER,
        contentType: 'image/jpeg',
        bytesBase64: Buffer.from('scan').toString('base64'),
        ...bindDual,
      })
      .catch((e: unknown) => e);
    const list = await op.kyc.listDocuments({ userId: USER, limit: 200 }).catch((e: unknown) => e);
    const bind = await op.kyc.bindDocument({ recordId: RECORD, documentId: DOC_ID, ...bindDual }).catch((e: unknown) => e);
    const get = await op.kyc.getDocument({ documentId: DOC_ID, ...bindDual }).catch((e: unknown) => e);
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
      ...bindDual,
    });
    expect(meta.id).toBe(DOC_ID);
    expect(meta.userId).toBe(USER);
    expect(meta).not.toHaveProperty('bytes');
    expect(meta).not.toHaveProperty('ciphertext');

    const list = await op.kyc.listDocuments({ userId: USER, limit: 200 });
    expect(Array.isArray(list)).toBe(true);
    for (const row of list) {
      expect(row).not.toHaveProperty('bytes');
    }

    const bindErr = await op.kyc.bindDocument({ recordId: RECORD, documentId: DOC_ID, ...bindDual }).catch((e: unknown) => e);
    expect(codeOf(bindErr)).not.toBe('PRECONDITION_FAILED');
    expect(String((bindErr as Error).message ?? bindErr)).not.toMatch(/kyc_doc\.unwired/);

    const getErr = await op.kyc.getDocument({ documentId: DOC_ID, ...bindDual }).catch((e: unknown) => e);
    expect(codeOf(getErr)).not.toBe('PRECONDITION_FAILED');
    expect(String((getErr as Error).message ?? getErr)).not.toMatch(/kyc_doc\.unwired/);
  });
});

describe('kyc.status never returns document bytes or provider_ref', () => {
  it('status payload omits providerRef, reviewedBy, and any bytes field', async () => {
    const r = productionRouter(randomBytes(32).toString('base64'));
    const user = r.createCaller(await ctx(['identity:read'], { userId: USER }));
    const status = await user.kyc.status({ limit: 200 });
    const wire = JSON.stringify(status);
    expect(wire).not.toContain('provider-pointer-that-must-not-leak');
    expect(status.records[0]).not.toHaveProperty('providerRef');
    expect(status.records[0]).not.toHaveProperty('reviewedBy');
    expect(status.records[0]).not.toHaveProperty('bytes');
    expect(wire).not.toMatch(/"bytes"|"ciphertext"|"bytesBase64"/);
  });

  it('bytes read is compliance getDocument only — kyc.status stays meta', async () => {
    expect(IDENTITY_KYC_GET_DOCUMENT.access).toEqual({ caller: 'scope', scope: 'admin:compliance' });
    // kyc.status's answer is meta: no field of a record it returns carries bytes or the provider pointer.
    for (const field of Object.keys(IDENTITY_KYC_STATUS.output.shape.records.element.shape)) {
      expect(field).not.toMatch(/bytes|ciphertext|providerRef/i);
    }
    // The vault doors are store, list, bind and get; no other door reads or downloads a document.
    const r = productionRouter(randomBytes(32).toString('base64'));
    const kycDoors = Object.keys(r._def.procedures).filter((p) => p.startsWith('kyc.') && /Documents?$/.test(p.split('.').pop() ?? ''));
    expect(kycDoors.sort()).toEqual(['kyc.bindDocument', 'kyc.getDocument', 'kyc.listDocuments', 'kyc.storeDocument']);
    // getDocument is the compliance door: a reader or support operator is refused before the vault is opened.
    for (const scopes of [['identity:read'], ['admin:read'], ['support:ops']]) {
      const caller = r.createCaller(await ctx(scopes, { mfa: true }));
      const err = await caller.kyc.getDocument({ documentId: DOC_ID, ...bindDual }).catch((e: unknown) => e);
      expect(codeOf(err), scopes.join()).toBe('FORBIDDEN');
    }
  });
});
