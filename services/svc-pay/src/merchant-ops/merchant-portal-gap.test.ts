import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
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
import { InvoiceService, parseInvoiceAmount } from './invoices.js';
import { scriptedSql } from '../scripted-sql.testkit.js';
import { MemoryLedger, formatAmount } from '@intafaced/ledger-client';

const here = dirname(fileURLToPath(import.meta.url));
const MERCHANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const INVOICE = '33333333-3333-4333-8333-333333333333';
const PAYMENT = '44444444-4444-4444-8444-444444444444';

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

  it('does not post a ledger entry from the invoice module', async () => {
    // An invoice is created and marked paid by a captured payment: the module writes only its own rows and reaches no
    // other service (svc-ledger is reached over HTTP), so marking paid moves no money.
    const invoiceRow = {
      id: INVOICE,
      status: 'draft',
      asset_id: 'USDT',
      amount: '10',
      customer_ref: null,
      customer_email: null,
      description: null,
      due_at: null,
      payment_link_id: null,
      payment_id: null,
      sent_at: null,
      voided_at: null,
      paid_at: null,
      created_at: new Date(),
      created_at_cursor: '2026-11-28T00:00:00.000000Z',
      updated_at: new Date(),
    };
    const { sql, calls } = scriptedSql<Sql>((call) => {
      if (call.text.includes('FROM pay.merchants')) return [{ status: 'active' }];
      if (call.text.includes('FROM pay.merchant_invoice_actions')) return [];
      if (call.text.includes('INSERT INTO pay.merchant_invoices')) return [invoiceRow];
      if (call.text.includes('UPDATE pay.merchant_invoices'))
        return [{ ...invoiceRow, status: 'paid', payment_id: PAYMENT, paid_at: new Date() }];
      if (call.text.includes('FROM pay.payments p')) return [{ id: PAYMENT, currency: 'USDT', amount: '10', status: 'captured' }];
      if (call.text.includes('FROM pay.merchant_invoices')) return [invoiceRow];
      return [];
    });
    const fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the invoice module called out'));
    const memoryPost = vi.spyOn(MemoryLedger.prototype, 'post');
    try {
      const invoices = new InvoiceService(sql);
      const caller = { merchantId: MERCHANT, userId: OWNER, role: 'owner', viaApiKey: false, interactive: true } as const;
      await invoices.create(caller, { requestId: 'inv-create-1', assetId: 'USDT', amount: '10' });
      await expect(
        invoices.markPaidByPayment(caller, { requestId: 'inv-paid-1', invoiceId: INVOICE, paymentId: PAYMENT }),
      ).resolves.toMatchObject({
        status: 'paid',
        paymentId: PAYMENT,
      });
      // Every other door of the module too (list, get, duplicate, send, reissue the link, void), with the link port
      // recorded: whatever each answers, it reaches nothing outside its own rows and the payment-link port.
      const linkCalls: string[] = [];
      const links = {
        createPaymentLink: async (input: { label: string }) => {
          linkCalls.push('createPaymentLink');
          return { id: 'link-1', token: 'tok', prefix: 'pl_', label: input.label, expiresAt: new Date(), maxUses: null };
        },
        deactivatePaymentLink: async () => {
          linkCalls.push('deactivatePaymentLink');
          return { deactivated: true };
        },
      };
      const withLinks = new InvoiceService(sql, links);
      const doors: Array<() => Promise<unknown>> = [
        () => withLinks.list(caller, { limit: 10 }),
        () => withLinks.get(caller, INVOICE),
        () => withLinks.duplicate(caller, { requestId: 'inv-dup-1', invoiceId: INVOICE }),
        () => withLinks.send(caller, { requestId: 'inv-send-1', invoiceId: INVOICE }),
        () => withLinks.reissueLink(caller, { requestId: 'inv-reissue-1', invoiceId: INVOICE }),
        () => withLinks.void(caller, { requestId: 'inv-void-1', invoiceId: INVOICE }),
      ];
      for (const door of doors) await door().catch(() => undefined);
      expect(linkCalls.length).toBeGreaterThan(0);
      expect(memoryPost).not.toHaveBeenCalled();
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
      memoryPost.mockRestore();
    }
    const writes = calls.map((c) => c.text.trim()).filter((text) => /^(INSERT|UPDATE|DELETE)\b/i.test(text));
    expect(writes.length).toBeGreaterThanOrEqual(5);
    for (const write of writes) expect(write).toMatch(/^(INSERT INTO|UPDATE) pay\.merchant_invoice(s|_actions|_lines)\b/);
  });
});
