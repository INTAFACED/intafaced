import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import { kycRecordOutput } from '@intafaced/contracts/identity-call-schemas';
import type { AuthService, KycRecordView } from '../auth/auth-service.js';
import { contextWith } from '../boot.testkit.js';
import { kycRecords } from '../db/schema.js';
import type { RankService } from '../rank/rank-service.js';
import { createIdentityRouter } from '../router.js';
import { KycDocumentStore, MemoryKycDocumentStore } from './document-store.js';

const BANNED_KYC_RECORD_COLUMNS = [
  'document_bytes',
  'document_data',
  'id_image',
  'passport',
  'selfie',
  'full_name',
  'date_of_birth',
  'national_id',
];

const here = dirname(fileURLToPath(import.meta.url));
const serviceRoot = join(here, '../..');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTs(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** The table's columns as the database names them, and as the code names them. */
function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.entries(getTableColumns(table)).flatMap(([key, column]) => [key.toLowerCase(), column.name.toLowerCase()]);
}

function assertKycRecordsColumnBan(columns: readonly string[]): void {
  expect(columns.length, 'kyc_records must have columns to check').toBeGreaterThan(0);
  for (const col of BANNED_KYC_RECORD_COLUMNS) {
    const camel = col.replace(/_(.)/g, (_m, c: string) => c).toLowerCase();
    expect(columns, `kyc_records must not define ${col}`).not.toContain(col);
    expect(columns, `kyc_records must not define ${col}`).not.toContain(camel);
  }
}

describe('PII isolation gate (kyc_records)', () => {
  it('forbids document/PII columns on kyc_records in schema', () => {
    const columns = columnNames(kycRecords);
    expect(columns).toContain('provider_ref');
    assertKycRecordsColumnBan(columns);
  });

  it('fails when the table has no columns to check, or a banned one', () => {
    expect(() => assertKycRecordsColumnBan([])).toThrow(/columns to check/);
    expect(() => assertKycRecordsColumnBan(['id', 'date_of_birth'])).toThrow(/date_of_birth/);
    expect(() => assertKycRecordsColumnBan(['id', 'idimage'])).toThrow(/id_image/);
  });

  it('document store table keeps ciphertext not plaintext columns', () => {
    const sql = readFileSync(join(serviceRoot, 'drizzle/0010_kyc_document_store.sql'), 'utf8').toLowerCase();
    expect(sql).toContain('ciphertext');
    expect(sql).toContain('nonce');
    expect(sql).not.toMatch(/\bplaintext\b/);
    expect(sql).not.toMatch(/\bdocument_text\b/);
  });

  it('store surface has no free get(id)/delete(id) — only principal-bound methods', async () => {
    // Free capability-by-id is the cross-user leak class: neither store has one.
    for (const Store of [KycDocumentStore, MemoryKycDocumentStore]) {
      const methods = Object.getOwnPropertyNames(Store.prototype);
      expect(methods, Store.name).not.toContain('get');
      expect(methods, Store.name).not.toContain('delete');
      expect(methods, Store.name).toEqual(expect.arrayContaining(['getFor', 'deleteFor', 'assertDocumentForUser']));
    }
    // And the bound methods hold: another owner cannot read, delete or claim the document.
    const store = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    const meta = await store.put({ userId: USER, contentType: 'image/png', bytes: Buffer.from('scan') });
    await expect(store.getFor(meta.id, { kind: 'owner', userId: OTHER })).rejects.toMatchObject({ code: 'kyc_doc.not_found' });
    await expect(store.deleteFor(meta.id, { kind: 'owner', userId: OTHER })).resolves.toBe(false);
    await expect(store.assertDocumentForUser(meta.id, OTHER)).rejects.toMatchObject({ code: 'kyc_doc.not_found' });
    await expect(store.getFor(meta.id, { kind: 'owner', userId: USER })).resolves.toMatchObject({ bytes: Buffer.from('scan') });
  });

  it('kyc.status presentation never includes provider_ref or document bytes', async () => {
    // The answer's shape is kyc.status's record: each record it returns, and the record schema it is built from.
    const recordFields = Object.keys(IDENTITY_KYC_STATUS.output.shape.records.element.shape);
    expect(recordFields).toEqual(Object.keys(kycRecordOutput.shape));
    expect(recordFields).toContain('tier');
    for (const field of [...Object.keys(IDENTITY_KYC_STATUS.output.shape), ...recordFields]) {
      expect(field).not.toMatch(/providerRef|provider_ref|bytes|ciphertext/i);
    }
    // What kyc.status answers for a record that carries a provider pointer, with a vault holding a document.
    const record: KycRecordView = {
      id: '33333333-3333-4333-8333-333333333333',
      userId: USER,
      tier: 'basic',
      jurisdiction: 'DE',
      providerRef: 'provider-pointer-that-must-not-leak',
      status: 'pending',
      reviewedBy: OTHER,
      reviewedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
    };
    const auth = partial<AuthService>({
      kycTier: async () => 'none' as const,
      listKycRecords: async () => [record],
      kycTradingOnly: async () => false,
    });
    const kycDocs = new MemoryKycDocumentStore(randomBytes(32).toString('base64'));
    await kycDocs.put({ userId: USER, contentType: 'image/png', bytes: Buffer.from('scan-bytes') });
    const router = createIdentityRouter(auth, partial<RankService>({}), { kycDocs });
    const status = await router.createCaller(await contextWith(['identity:read'], { userId: USER })).kyc.status({ limit: 200 });
    expect(status.records).toHaveLength(1);
    const wire = JSON.stringify(status);
    expect(wire).not.toContain('provider-pointer-that-must-not-leak');
    expect(wire).not.toContain(Buffer.from('scan-bytes').toString('base64'));
    expect(wire).not.toMatch(/providerRef|provider_ref|"bytes|ciphertext|bytesBase64/);
  });

  it('no other service under monorepo services/ reads kyc_documents', () => {
    const monorepo = join(serviceRoot, '../..');
    const servicesDir = join(monorepo, 'services');
    const offenders: string[] = [];
    for (const svc of readdirSync(servicesDir)) {
      if (svc === 'svc-identity') continue;
      const srcDir = join(servicesDir, svc, 'src');
      try {
        if (!statSync(srcDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of walkTs(srcDir)) {
        const text = readFileSync(file, 'utf8');
        if (/kyc_documents|KycDocumentStore|document-store\.js/.test(text)) {
          offenders.push(relative(monorepo, file));
        }
      }
    }
    expect(offenders, `foreign services must not touch the KYC vault:\n${offenders.join('\n')}`).toEqual([]);
  });
});
