import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

function assertKycRecordsColumnBan(schema: string): void {
  const start = schema.indexOf('export const kycRecords');
  expect(start, 'schema must declare export const kycRecords').toBeGreaterThanOrEqual(0);
  const end = schema.indexOf('export const rankState', start);
  const block = schema.slice(start, end === -1 ? undefined : end).toLowerCase();
  expect(block, 'kyc_records block must not be an empty slice').not.toBe('');
  for (const col of BANNED_KYC_RECORD_COLUMNS) {
    expect(block, `kyc_records must not define ${col}`).not.toMatch(new RegExp(`['"\`]${col}['"\`]|\\b${col}:`));
  }
}

describe('PII isolation gate (kyc_records)', () => {
  it('forbids document/PII columns on kyc_records in schema', () => {
    const schema = readFileSync(join(serviceRoot, 'src/db/schema.ts'), 'utf8');
    assertKycRecordsColumnBan(schema);
  });

  it('fails when schema text has no kycRecords export', () => {
    const schema = [
      "export const profiles = identity.table('profiles', {});",
      "export const rankState = identity.table('rank_state', {});",
    ].join('\n');
    expect(() => assertKycRecordsColumnBan(schema)).toThrow(/kycRecords/);
  });

  it('document store table keeps ciphertext not plaintext columns', () => {
    const sql = readFileSync(join(serviceRoot, 'drizzle/0010_kyc_document_store.sql'), 'utf8').toLowerCase();
    expect(sql).toContain('ciphertext');
    expect(sql).toContain('nonce');
    expect(sql).not.toMatch(/\bplaintext\b/);
    expect(sql).not.toMatch(/\bdocument_text\b/);
  });

  it('store surface has no free get(id)/delete(id) — only principal-bound methods', () => {
    const storeSrc = readFileSync(join(serviceRoot, 'src/kyc/document-store.ts'), 'utf8');
    // Free capability-by-id is the cross-user leak class.
    expect(storeSrc).not.toMatch(/async get\(id:/);
    expect(storeSrc).not.toMatch(/async delete\(id:/);
    expect(storeSrc).toMatch(/async getFor\(/);
    expect(storeSrc).toMatch(/async deleteFor\(/);
    expect(storeSrc).toMatch(/assertDocumentForUser/);
  });

  it('kyc.status presentation never includes provider_ref or document bytes', () => {
    const routerSrc = readFileSync(join(serviceRoot, 'src/router.ts'), 'utf8');
    const schemaStart = routerSrc.indexOf('const kycRecordOutput = z.object({');
    const schema = routerSrc.slice(schemaStart, routerSrc.indexOf('});', schemaStart));
    expect(schema).not.toMatch(/providerRef|provider_ref|bytes|ciphertext/);
    const fnStart = routerSrc.indexOf('function presentKyc');
    const returned = routerSrc.slice(
      routerSrc.indexOf('return {', fnStart),
      routerSrc.indexOf('};', routerSrc.indexOf('return {', fnStart)),
    );
    expect(returned).not.toMatch(/providerRef|provider_ref|bytes|ciphertext/);
    const statusBlock = routerSrc.slice(routerSrc.indexOf('status: scopedProcedure'), routerSrc.indexOf('approve: scopedProcedure'));
    expect(statusBlock).toMatch(/presentKyc/);
    expect(statusBlock).not.toMatch(/getFor|ciphertext|bytesBase64/);
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
