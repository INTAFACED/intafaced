import { describe, expect, it } from 'vitest';
import type { AuditRecord } from './pipeline.js';
import { loadProductAudits, productAudits } from './products.js';
import { evaluateExternalClaim, type ExternalClaim } from './registry.js';

const HASH = `0x${'1'.repeat(64)}` as const;
const claim = (over: Partial<ExternalClaim> = {}): ExternalClaim => ({
  id: 'TEST-report',
  packagePath: 'docs/TEST-report.md',
  kind: 'external',
  signedBy: 'TEST auditor',
  signedAt: '2026-11-07',
  expectedHash: HASH,
  products: ['swap'],
  ...over,
});
const record = (audited: boolean): AuditRecord => ({
  id: 'TEST-report',
  kind: 'external',
  packagePath: 'docs/TEST-report.md',
  artifactHash: HASH,
  signedBy: 'TEST auditor',
  signedAt: '2026-11-07',
  audited,
});

describe('audit room per-product rows (D-developer-compliance-02)', () => {
  it('with no external audit recorded, every product row has none (External audit: not done)', () => {
    const rows = loadProductAudits();
    expect(rows.products.map((row) => row.product)).toEqual(['swap', 'pools', 'lending', 'orders', 'launch', 'bridge']);
    expect(rows.products.every((row) => row.external === null)).toBe(true);
    // The internal package is listed as internal, never as an audit.
    expect(rows.internal.map((row) => row.id)).toEqual(['protocol-smart-accounts']);
  });

  it('an owner-recorded report whose hash matches fills only the products it names, with date, scope and link', () => {
    const rows = productAudits(
      [{ claim: claim({ scope: 'TEST: the swap router', reportUrl: 'https://example.test/r' }), record: record(true) }],
      [],
    );
    expect(rows.products.find((row) => row.product === 'swap')?.external).toEqual({
      id: 'TEST-report',
      packagePath: 'docs/TEST-report.md',
      signedBy: 'TEST auditor',
      signedAt: '2026-11-07',
      scope: 'TEST: the swap router',
      reportUrl: 'https://example.test/r',
    });
    expect(rows.products.filter((row) => row.external !== null)).toHaveLength(1);
  });

  it('a report whose hash does not match, or that names no product, fills nothing', () => {
    const none = (rows: ReturnType<typeof productAudits>) => rows.products.every((row) => row.external === null);
    expect(none(productAudits([{ claim: claim(), record: record(false) }], []))).toBe(true);
    expect(none(productAudits([{ claim: claim({ products: undefined }), record: record(true) }], []))).toBe(true);
    // A claim whose package could not be read fills nothing.
    expect(none(productAudits([{ claim: claim(), record: null }], []))).toBe(true);
  });

  it("a claim never borrows another claim's passing check, even with the same id", () => {
    const rows = productAudits(
      [
        { claim: claim({ products: ['swap'] }), record: record(true) },
        { claim: claim({ products: ['bridge', 'lending'] }), record: record(false) },
      ],
      [],
    );
    expect(rows.products.filter((row) => row.external !== null).map((row) => row.product)).toEqual(['swap']);
  });

  it('a claim whose package file is missing is skipped, never thrown', () => {
    expect(evaluateExternalClaim(claim({ packagePath: 'no/such/TEST-report.md' }))).toBeNull();
  });
});
