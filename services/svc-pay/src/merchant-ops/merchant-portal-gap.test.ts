import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_CONTENT_BYTE_CEILING,
  EVIDENCE_CONTENT_TYPES,
  assertEvidenceContentType,
  assertEvidenceFileName,
  decodeEvidenceContent,
  disputeEvidenceScanEnabled,
  disputeEvidenceUploadEnabled,
} from './dispute-evidence-policy.js';
import { MerchantOpsError } from './errors.js';
import { parseInvoiceAmount } from './invoices.js';
import { formatAmount } from '@intafaced/ledger-client';

const here = dirname(fileURLToPath(import.meta.url));

describe('dispute evidence policy', () => {
  it('enables upload and scan only for the exact env value on', () => {
    expect(disputeEvidenceUploadEnabled({ PAY_DISPUTE_EVIDENCE_UPLOAD: 'on' })).toBe(true);
    expect(disputeEvidenceScanEnabled({ PAY_DISPUTE_EVIDENCE_SCAN: 'on' })).toBe(true);
    for (const value of ['true', '1', 'ON', 'yes', '']) {
      expect(disputeEvidenceUploadEnabled({ PAY_DISPUTE_EVIDENCE_UPLOAD: value })).toBe(false);
      expect(disputeEvidenceScanEnabled({ PAY_DISPUTE_EVIDENCE_SCAN: value })).toBe(false);
    }
    expect(disputeEvidenceUploadEnabled({})).toBe(false);
    expect(disputeEvidenceScanEnabled({})).toBe(false);
  });

  it('allows the security content types and rejects the rest', () => {
    expect(assertEvidenceContentType(' Application/PDF ')).toBe('application/pdf');
    expect(EVIDENCE_CONTENT_TYPES).toEqual(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']);
    expect(() => assertEvidenceContentType('application/zip')).toThrow(MerchantOpsError);
  });

  it('rejects file names that could be a path', () => {
    expect(assertEvidenceFileName(' receipt.pdf ')).toBe('receipt.pdf');
    expect(() => assertEvidenceFileName('../receipt.pdf')).toThrow(MerchantOpsError);
    expect(() => assertEvidenceFileName('a/b.pdf')).toThrow(MerchantOpsError);
    expect(() => assertEvidenceFileName('a\\b.pdf')).toThrow(MerchantOpsError);
  });

  it('decodes canonical base64 and refuses an empty or oversized blob', () => {
    expect(decodeEvidenceContent(Buffer.from('%PDF').toString('base64')).toString()).toBe('%PDF');
    expect(() => decodeEvidenceContent('   ')).toThrow(MerchantOpsError);
    expect(() => decodeEvidenceContent('@@@@')).toThrow(MerchantOpsError);
    const over = Buffer.alloc(EVIDENCE_CONTENT_BYTE_CEILING + 1, 1).toString('base64');
    expect(() => decodeEvidenceContent(over)).toThrow(MerchantOpsError);
  });

  it('keeps the byte ceiling equal to the migration CHECK', () => {
    const sql = readFileSync(join(here, '..', '..', 'drizzle', '0083_pay_dispute_deadlines_evidence.sql'), 'utf8');
    expect(sql).toContain('1048576');
    expect(EVIDENCE_CONTENT_BYTE_CEILING).toBe(1_048_576);
  });
});

describe('invoice amounts', () => {
  it('canonicalizes a positive decimal and refuses zero, a sign, and an exponent', () => {
    expect(formatAmount(parseInvoiceAmount('10.00'))).toBe('10');
    expect(formatAmount(parseInvoiceAmount('0.5'))).toBe('0.5');
    for (const raw of ['0', '-1', '+1', '1e2', '1.2.3', '']) {
      expect(() => parseInvoiceAmount(raw)).toThrow(MerchantOpsError);
    }
  });

  it('does not post a ledger entry from the invoice module', () => {
    const source = readFileSync(join(here, 'invoices.ts'), 'utf8');
    expect(source).not.toMatch(/ledger\.post|recipes\.|chargebackOpen|withdrawHold/);
  });
});
