import { describe, expect, it } from 'vitest';
import {
  OPS_IMPORT_INVALID,
  OPS_SEGMENT_CAP_UNSET,
  opsAddContactInputSchema,
  opsEnquiryIntakeErrorCodeSchema,
  opsImportContactsInputSchema,
  opsImportReportSchema,
  opsImportRowSchema,
  opsSegmentCapSchema,
  opsSegmentSaveInputSchema,
} from './ops-enquiry-intake.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contact = { name: 'Ada', email: 'ada@example.com', interests: ['merchant'], marketingOptIn: false };

describe('enquiry intake contracts (SP-contacts-01)', () => {
  it('declares the three new codes', () => {
    expect(opsEnquiryIntakeErrorCodeSchema.options).toEqual(['ops.segment_cap_unset', 'ops.import_invalid', 'ops.contact_reason_required']);
  });
  it('manual add requires a reason and a source', () => {
    const input = { requestId: uuid, contact, source: 'manual', reason: 'met at event' };
    expect(opsAddContactInputSchema.parse(input)).toEqual(input);
    expect(opsAddContactInputSchema.safeParse({ ...input, reason: '  ' }).success).toBe(false);
    const { source: _s, ...noSource } = input;
    expect(opsAddContactInputSchema.safeParse(noSource).success).toBe(false);
    expect(opsAddContactInputSchema.safeParse({ ...input, source: 'unknown' }).success).toBe(false);
    expect(opsAddContactInputSchema.safeParse({ ...input, customerId: uuid }).success).toBe(false);
  });
  it('accepts chat as a source', () => {
    expect(opsAddContactInputSchema.safeParse({ requestId: uuid, contact, source: 'chat', reason: 'pre-chat form' }).success).toBe(true);
  });
  it('import input needs a header, rows and a business source key', () => {
    const input = { importSource: 'fair-2026', reason: 'event list', dryRun: true, header: ['name', 'email'], rows: [{}] };
    expect(opsImportContactsInputSchema.safeParse(input).success).toBe(true);
    expect(opsImportContactsInputSchema.safeParse({ ...input, header: [] }).success).toBe(false);
    expect(opsImportContactsInputSchema.safeParse({ ...input, rows: [] }).success).toBe(false);
    expect(opsImportContactsInputSchema.safeParse({ ...input, importSource: 'has space' }).success).toBe(false);
    expect(opsImportContactsInputSchema.safeParse({ ...input, reason: '' }).success).toBe(false);
  });
  it('import row needs a row key and a data line after the header', () => {
    expect(opsImportRowSchema.safeParse({ line: 2, rowKey: 'r1', contact }).success).toBe(true);
    expect(opsImportRowSchema.safeParse({ line: 1, rowKey: 'r1', contact }).success).toBe(false);
    expect(opsImportRowSchema.safeParse({ line: 2, rowKey: '', contact }).success).toBe(false);
  });
  it('report lists stored and refused lines; refusals carry ops.import_invalid', () => {
    const report = {
      importSource: 'fair-2026',
      dryRun: false,
      outcomes: [
        { line: 2, status: 'stored', contactId: uuid },
        { line: 3, status: 'already_stored', contactId: uuid },
        { line: 4, status: 'refused', code: OPS_IMPORT_INVALID, field: 'email' },
      ],
    };
    expect(opsImportReportSchema.parse(report)).toEqual(report);
    expect(
      opsImportReportSchema.safeParse({ ...report, outcomes: [{ line: 4, status: 'refused', code: 'other', field: null }] }).success,
    ).toBe(false);
    expect(opsImportReportSchema.safeParse({ ...report, outcomes: [report.outcomes[0], report.outcomes[0]] }).success).toBe(false);
  });
  it('report status must match dry run', () => {
    expect(
      opsImportReportSchema.safeParse({ importSource: 'a', dryRun: true, outcomes: [{ line: 2, status: 'stored', contactId: uuid }] })
        .success,
    ).toBe(false);
    expect(
      opsImportReportSchema.safeParse({ importSource: 'a', dryRun: false, outcomes: [{ line: 2, status: 'would_store' }] }).success,
    ).toBe(false);
    expect(
      opsImportReportSchema.safeParse({ importSource: 'a', dryRun: true, outcomes: [{ line: 2, status: 'would_store' }] }).success,
    ).toBe(true);
  });
  it('segment cap is unset with its code or a positive set value, never defaulted', () => {
    expect(opsSegmentCapSchema.parse({ status: 'unset', code: OPS_SEGMENT_CAP_UNSET })).toEqual({
      status: 'unset',
      code: OPS_SEGMENT_CAP_UNSET,
    });
    expect(opsSegmentCapSchema.safeParse({ status: 'set', cap: 0 }).success).toBe(false);
    expect(opsSegmentCapSchema.safeParse({ status: 'set' }).success).toBe(false);
    expect(opsSegmentCapSchema.safeParse({ status: 'unset' }).success).toBe(false);
  });
  it('segment save validates its filter', () => {
    const input = { requestId: uuid, name: 'Merchants', filter: { interests: ['merchant'], sources: ['import'] } };
    expect(opsSegmentSaveInputSchema.safeParse(input).success).toBe(true);
    expect(opsSegmentSaveInputSchema.safeParse({ ...input, name: '' }).success).toBe(false);
    expect(
      opsSegmentSaveInputSchema.safeParse({ ...input, filter: { createdFrom: '2026-02-01T00:00:00Z', createdTo: '2026-01-01T00:00:00Z' } })
        .success,
    ).toBe(false);
    expect(opsSegmentSaveInputSchema.safeParse({ ...input, filter: { stages: ['bogus'] } }).success).toBe(false);
  });
});
