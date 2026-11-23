import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePackage, hashPackageContents } from './pipeline.js';
import { evaluateExternalClaim, EXTERNAL_CLAIMS_PATH, loadExternalClaims, loadInternalPackageRecords } from './registry.js';

describe('protocol audit registry (Q-proto intake)', () => {
  it('loads the internal smart-accounts package and keeps audited false', () => {
    const records = loadInternalPackageRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('protocol-smart-accounts');
    expect(records[0]?.kind).toBe('internal');
    expect(records[0]?.audited).toBe(false);
  });

  it('the committed external-claims.json is empty, so nothing reads as audited', () => {
    expect(loadExternalClaims()).toEqual([]);
  });

  it('refuses audited:true when an external claim hash does not match report bytes', () => {
    const record = evaluatePackage(
      {
        id: 'fixture-tampered',
        packagePath: 'memory:fixture',
        kind: 'external',
        signedBy: 'example-firm',
        signedAt: '2026-01-01T00:00:00.000Z',
        expectedHash: hashPackageContents('expected body'),
      },
      'wrong body',
    );
    expect(record.audited).toBe(false);
    expect(record.kind).toBe('none');
  });

  it('intake: matching firm report on a temp root is the only audited:true path', () => {
    const root = mkdtempSync(join(tmpdir(), 'q-proto-audit-'));
    const reportRel = 'docs/audits/external/fixture-report.md';
    mkdirSync(join(root, 'docs/audits/external'), { recursive: true });
    mkdirSync(join(root, 'services/svc-protocol/src/audit'), { recursive: true });
    writeFileSync(join(root, reportRel), 'reviewed package body\n');
    writeFileSync(
      join(root, EXTERNAL_CLAIMS_PATH),
      JSON.stringify({
        claims: [
          {
            id: 'fixture-external',
            packagePath: reportRel,
            kind: 'external',
            signedBy: 'example-firm',
            signedAt: '2026-01-01T00:00:00.000Z',
            expectedHash: hashPackageContents('reviewed package body\n'),
          },
        ],
      }),
    );
    const claims = loadExternalClaims(root);
    expect(claims).toHaveLength(1);
    const record = evaluateExternalClaim(claims[0]!, root);
    expect(record?.audited).toBe(true);
    expect(record?.kind).toBe('external');
    expect(loadExternalClaims()).toEqual([]);
  });
});
