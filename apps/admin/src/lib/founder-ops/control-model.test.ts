import { describe, expect, it } from 'vitest';
import { auditFilterOf, auditInput, hasAuditFilter, jsonPreview } from './control-model';

const MID = '22222222-2222-4222-8222-222222222222';

describe('audit filters', () => {
  it('no filter asks for one page only', () => {
    expect(auditInput({})).toEqual({ ok: true, input: { limit: 25 } });
    expect(hasAuditFilter(auditFilterOf({}))).toBe(false);
  });
  it('turns dates into inclusive UTC bounds and lowercases the merchant id', () => {
    expect(auditInput({ merchant: MID.toUpperCase(), kind: ' set_caps ', from: '2026-10-01', to: '2026-10-01' })).toEqual({
      ok: true,
      input: { limit: 25, merchantId: MID, kind: 'set_caps', from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T23:59:59.999Z' },
    });
  });
  it.each([
    [{ merchant: 'nope' }, 'full id'],
    [{ from: '2026-13-01' }, 'real date'],
    [{ to: '01/02/2026' }, 'real date'],
    [{ from: '2026-10-02', to: '2026-10-01' }, 'after'],
  ])('refuses %j before any read', (query, text) => {
    const result = auditInput(query);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(' ')).toContain(text);
  });
  it('keeps a cursor only when it is a bigint-sized number', () => {
    expect(auditInput({ cursor: '12' })).toMatchObject({ input: { cursor: '12' } });
    expect(auditInput({ cursor: '99999999999999999999' })).toEqual({ ok: true, input: { limit: 25 } });
    expect(auditInput({ cursor: '1 or 1' })).toEqual({ ok: true, input: { limit: 25 } });
  });
});

describe('before and after text', () => {
  it('keeps money strings exactly and hides destination-like keys', () => {
    const text = jsonPreview({ limit: '9007199254740993.000000000000000001', destinationRef: 'DE00X', nested: { iban: 'DE11' } });
    expect(text).toContain('9007199254740993.000000000000000001');
    expect(text).not.toContain('DE00X');
    expect(text).not.toContain('DE11');
  });
  it('is empty for nothing and shortened when long', () => {
    expect(jsonPreview(null)).toBe('');
    expect(jsonPreview({ a: 'x'.repeat(5000) })).toContain('shortened');
  });
});
