import { describe, expect, it } from 'vitest';
import {
  kybApplicationChangeTypeInputSchema,
  kybApplicationRestartInputSchema,
  kybApplicationSaveSectionInputSchema,
  kybApplicationSectionDataSchema,
  kybApplicationStartInputSchema,
} from './kyb-application.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('kyb application contracts', () => {
  it('accepts short text, yes/no and short lists as section answers, and refuses anything else', () => {
    expect(kybApplicationSectionDataSchema.safeParse({ legal_name: 'Acme', has_board: true, directors: ['A', 'B'] }).success).toBe(true);
    expect(kybApplicationSectionDataSchema.safeParse({ capital: 5 }).success).toBe(false);
    expect(kybApplicationSectionDataSchema.safeParse({ 'Legal Name': 'Acme' }).success).toBe(false);
    expect(kybApplicationSectionDataSchema.safeParse({ nested: { a: 'b' } }).success).toBe(false);
  });

  it('bounds a section to 100 fields', () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`f${i}`, 'x']));
    expect(kybApplicationSectionDataSchema.safeParse(many).success).toBe(false);
  });

  it('a save names the version it read', () => {
    const body = { applicationId: id, section: 'people', complete: false, data: {} };
    expect(kybApplicationSaveSectionInputSchema.safeParse(body).success).toBe(false);
    expect(kybApplicationSaveSectionInputSchema.safeParse({ ...body, expectedVersion: 0 }).success).toBe(true);
    expect(kybApplicationSaveSectionInputSchema.safeParse({ ...body, expectedVersion: 0, section: 'bank' }).success).toBe(false);
  });

  it('restart needs an explicit confirmation, and start upper-cases the country', () => {
    expect(kybApplicationRestartInputSchema.safeParse({ applicationId: id }).success).toBe(false);
    expect(kybApplicationRestartInputSchema.safeParse({ applicationId: id, confirm: true }).success).toBe(true);
    expect(kybApplicationStartInputSchema.parse({ merchantId: id, entityType: 'fund', country: 'de' }).country).toBe('DE');
  });

  it('a type change names a known type and a two-letter country', () => {
    expect(kybApplicationChangeTypeInputSchema.parse({ applicationId: id, entityType: 'trust', country: 'fr' }).country).toBe('FR');
    expect(kybApplicationChangeTypeInputSchema.safeParse({ applicationId: id, entityType: 'llc', country: 'FR' }).success).toBe(false);
    expect(kybApplicationChangeTypeInputSchema.safeParse({ applicationId: id, entityType: 'trust', country: 'FRA' }).success).toBe(false);
  });
});
