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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDENTITY_KYC_LIST_DOCUMENTS } from '@intafaced/contracts/identity-kyc-procedures';
import {
  IDENTITY_KYC_DOCUMENTS_LIST_LIMIT_UNSET,
  KYC_DOCUMENTS_LIST_LIMIT_MAX,
  KycDocumentStore,
  KycDocumentsListLimitUnsetError,
  MemoryKycDocumentStore,
  publishedKycDocumentsListLimit,
} from './document-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function unreachableSql(): { sql: ConstructorParameters<typeof KycDocumentStore>[0]; sqlCalled: () => boolean } {
  let sqlCalled = false;
  const sql = Object.assign(() => {
    sqlCalled = true;
    throw new Error('sql must not run when KYC documents list limit is unset');
  }, {}) as never;
  return { sql, sqlCalled: () => sqlCalled };
}

describe('kyc.listDocuments / listMetaForUser limit unset refuse (no invented page)', () => {
  it('router.ts requires limit 1..200 and passes input.limit', () => {
    const src = readFileSync(join(HERE, '../router.ts'), 'utf8');
    expect(src).not.toMatch(/listMetaForUser\(input\.userId\)\)/);
    expect(src).toMatch(/listMetaForUser\(input\.userId, input\.limit\)/);
    expect(src).toMatch(/listDocuments: mountRecord\(\s*IDENTITY_KYC_LIST_DOCUMENTS,/);
    expect(IDENTITY_KYC_LIST_DOCUMENTS.access).toEqual({ caller: 'scope', scope: 'admin:compliance' });
    // The record is the input schema: the limit is required, an integer in 1..200, with no default.
    for (const limit of [1, 200])
      expect(IDENTITY_KYC_LIST_DOCUMENTS.input.safeParse({ userId: '11111111-1111-4111-8111-111111111111', limit }).success).toBe(true);
    for (const limit of [undefined, null, 0, 201, 1.5])
      expect(IDENTITY_KYC_LIST_DOCUMENTS.input.safeParse({ userId: '11111111-1111-4111-8111-111111111111', limit }).success).toBe(false);
    expect(src).not.toMatch(/\?\? 50|\?\? 100/);
  });

  it('document-store.ts does not invent a page via default param', () => {
    const src = readFileSync(join(HERE, 'document-store.ts'), 'utf8');
    expect(src).not.toMatch(/async listMetaForUser\([^)]*limit = /);
    expect(src).toMatch(/publishedKycDocumentsListLimit\(limit\)/);
    expect(src).toMatch(/LIMIT \$\{published\}/);
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
