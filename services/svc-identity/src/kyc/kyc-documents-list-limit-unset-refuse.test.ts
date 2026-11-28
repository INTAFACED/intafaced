/**
 * Unit card — kyc.listDocuments limit unset refuse (no invented page, no dump)
 *
 * 1. Promise: omitted document-meta limit does not dump KYC meta or become a default page.
 * 2. Break: listMetaForUser(userId) with no limit dressed a blank page as every vault row.
 * 3. Done bar: no listMetaForUser(userId) without limit; no input?.limit / ?? / .default;
 *    unset/null/out of 1..200 throw identity.kyc_documents_list_limit_unset before SQL.
 * 4. Class N
 * 5. Paths: router.ts kyc.listDocuments; document-store.ts listMetaForUser
 * 6. RED: omitting limit returns every document meta row for the user
 */
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { AuthService } from '../auth/auth-service.js';
import { contextWith } from '../boot.testkit.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { IDENTITY_KYC_LIST_DOCUMENTS } from '@intafaced/contracts/identity-kyc-procedures';
import {
  IDENTITY_KYC_DOCUMENTS_LIST_LIMIT_UNSET,
  KYC_DOCUMENTS_LIST_LIMIT_MAX,
  KycDocumentStore,
  type KycDocumentVault,
  KycDocumentsListLimitUnsetError,
  MemoryKycDocumentStore,
  publishedKycDocumentsListLimit,
} from './document-store.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function unreachableSql(): { sql: ConstructorParameters<typeof KycDocumentStore>[0]; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when KYC documents list limit is unset');
  }, {}) as never;
  return { sql, sqlCalled: () => sqlCalled };
}

describe('kyc.listDocuments / listMetaForUser limit unset refuse (no invented page)', () => {
  it('kyc.listDocuments refuses an omitted limit before the store and passes an explicit one', async () => {
    // The record is the input schema: the limit is required, an integer in 1..200, with no default.
    expect(IDENTITY_KYC_LIST_DOCUMENTS.access).toEqual({ caller: 'scope', scope: 'admin:compliance' });
    for (const limit of [1, 200]) expect(IDENTITY_KYC_LIST_DOCUMENTS.input.safeParse({ userId: USER, limit }).success).toBe(true);
    for (const limit of [undefined, null, 0, 201, 1.5])
      expect(IDENTITY_KYC_LIST_DOCUMENTS.input.safeParse({ userId: USER, limit }).success).toBe(false);

    const asked: Array<[string, number]> = [];
    const kycDocs = partial<KycDocumentVault>({
      listMetaForUser: async (userId: string, limit: number) => {
        asked.push([userId, limit]);
        return [];
      },
    });
    const router = createIdentityRouter(partial<AuthService>({}), partial<RankService>({}), {
      kycDocs,
      kycDocumentReviews: async () => new Map(),
    });
    const user = router.createCaller(await contextWith(['identity:read', 'identity:write'], { userId: USER }));
    await expect(user.kyc.listDocuments({ userId: USER, limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const op = router.createCaller(await contextWith(['admin:compliance'], { userId: OPERATOR, mfa: true }));
    for (const input of [{ userId: USER }, { userId: USER, limit: null }, { userId: USER, limit: 0 }, { userId: USER, limit: 201 }]) {
      await expect(op.kyc.listDocuments(input as never), JSON.stringify(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(asked).toEqual([]);
    await expect(op.kyc.listDocuments({ userId: USER, limit: 50 })).resolves.toEqual([]);
    expect(asked).toEqual([[USER, 50]]);
  });

  it('an explicit limit reaches the query as its LIMIT', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as never;
    await expect(new KycDocumentStore(sql, Buffer.alloc(32).toString('base64')).listMetaForUser(USER, 50)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/FROM kyc_documents[\s\S]*WHERE user_id = \?[\s\S]*LIMIT \?\s*$/);
    expect(queries[0]!.values).toEqual([USER, 50]);
  });

  it('blank / non-integer / out of 1..200 throws identity.kyc_documents_list_limit_unset', () => {
    for (const limit of [undefined, null, 0, -1, 201, 1.5, Number.NaN]) {
      try {
        publishedKycDocumentsListLimit(limit);
        expect.unreachable(`expected throw for limit=${String(limit)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(KycDocumentsListLimitUnsetError);
        expect((err as KycDocumentsListLimitUnsetError).code).toBe(IDENTITY_KYC_DOCUMENTS_LIST_LIMIT_UNSET);
      }
    }
  });

  it('owner-explicit 1 and max are published windows', () => {
    expect(publishedKycDocumentsListLimit(1)).toBe(1);
    expect(publishedKycDocumentsListLimit(KYC_DOCUMENTS_LIST_LIMIT_MAX)).toBe(200);
  });

  it('omitted / undefined / null limit refuses before SQL', async () => {
    for (const limit of [undefined, null] as unknown as number[]) {
      const { sql, sqlCalled } = unreachableSql();
      const store = new KycDocumentStore(sql, 'not-a-key');
      await expect(store.listMetaForUser(USER, limit)).rejects.toMatchObject({
        name: 'KycDocumentsListLimitUnsetError',
        code: IDENTITY_KYC_DOCUMENTS_LIST_LIMIT_UNSET,
      });
      expect(sqlCalled()).toBe(false);
    }
  });

  it('memory vault also refuses unset limit before walking rows', async () => {
    const store = new MemoryKycDocumentStore(Buffer.alloc(32).toString('base64'));
    await expect(store.listMetaForUser(USER, undefined as unknown as number)).rejects.toMatchObject({
      name: 'KycDocumentsListLimitUnsetError',
      code: IDENTITY_KYC_DOCUMENTS_LIST_LIMIT_UNSET,
    });
  });
});
