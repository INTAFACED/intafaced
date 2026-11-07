import { describe, expect, it } from 'vitest';
import type { AuditRecord } from './pipeline.js';
import { loadProductAudits, productAudits } from './products.js';
import type { ExternalClaim } from './registry.js';

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
    const rows = productAudits([claim()], [record(true)], []);
    expect(rows.products.find((row) => row.product === 'swap')?.external).toEqual({
      id: 'TEST-report',
      packagePath: 'docs/TEST-report.md',
      signedBy: 'TEST auditor',
      signedAt: '2026-11-07',
    });
    expect(rows.products.filter((row) => row.external !== null)).toHaveLength(1);
  });

  it('a report whose hash does not match, or that names no product, fills nothing', () => {
    expect(productAudits([claim()], [record(false)], []).products.every((row) => row.external === null)).toBe(true);
    expect(productAudits([claim({ products: undefined })], [record(true)], []).products.every((row) => row.external === null)).toBe(true);
  });
});
