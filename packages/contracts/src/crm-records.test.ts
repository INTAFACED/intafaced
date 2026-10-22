import { describe, expect, it } from 'vitest';
import {
  OPS_CRM_FIELD_TYPE_UNSUPPORTED,
  OPS_CRM_RELATION_INVALID,
  OPS_CRM_SEARCH_TERM_TOO_SHORT,
  checkCrmFieldDefinition,
  checkCrmRelationDefinition,
  checkCrmSearchTerm,
  crmDealSchema,
  crmFieldDefinitionInputSchema,
  crmLayoutSaveInputSchema,
  crmSearchOutputSchema,
  type CrmFieldDefinitionInput,
} from './crm-records.js';

/** TEST data only. */
const field: CrmFieldDefinitionInput = {
  recordType: 'company',
  apiName: 'tier',
  label: 'TEST tier',
  type: 'select',
  options: [
    { label: 'Gold', apiValue: 'gold' },
    { label: 'Silver', apiValue: 'silver' },
  ],
  defaultValue: 'gold',
  unique: false,
  businessKey: 'crm:field:company:tier',
};

describe('custom field definitions', () => {
  it('accepts a select with a default among its options', () => {
    expect(crmFieldDefinitionInputSchema.safeParse(field).success).toBe(true);
    expect(checkCrmFieldDefinition(field)).toEqual({ ok: true });
  });

  it('refuses an unknown type with ops.crm.field_type_unsupported', () => {
    expect(checkCrmFieldDefinition({ ...field, type: 'formula' })).toMatchObject({ ok: false, code: OPS_CRM_FIELD_TYPE_UNSUPPORTED });
  });

  it('has no required flag: custom fields cannot be required', () => {
    expect(crmFieldDefinitionInputSchema.safeParse({ ...field, required: true }).success).toBe(false);
  });

  it.each([
    ['select without options', { options: [] }],
    ['options on a text field', { type: 'text', defaultValue: null }],
    ['duplicate option values', { options: [field.options![0], field.options![0]] }],
    ['default not an option', { defaultValue: 'bronze' }],
    ['unique multi-select', { type: 'multi_select', defaultValue: null, unique: true }],
    ['number default as non-decimal', { type: 'number', options: undefined, defaultValue: '1e3' }],
    ['boolean default as text', { type: 'boolean', options: undefined, defaultValue: 'yes' }],
    ['bad date default', { type: 'date', options: undefined, defaultValue: '22/10/2026' }],
    ['multi-select default not options', { type: 'multi_select', defaultValue: ['bronze'] }],
    ['text default not text', { type: 'text', options: undefined, defaultValue: true }],
  ])('refuses %s', (_l, patch) => {
    expect(checkCrmFieldDefinition({ ...field, ...patch } as CrmFieldDefinitionInput).ok).toBe(false);
  });

  it('accepts a decimal-string number default and a null default', () => {
    expect(checkCrmFieldDefinition({ ...field, type: 'number', options: undefined, defaultValue: '12.50' })).toEqual({ ok: true });
    expect(checkCrmFieldDefinition({ ...field, type: 'text', options: undefined, defaultValue: null })).toEqual({ ok: true });
  });
});

describe('relations', () => {
  const rel = {
    kind: 'many_to_one',
    fromType: 'contact',
    toType: 'company',
    fromLabel: 'Company',
    toLabel: 'People',
    businessKey: 'k',
  } as const;
  it('accepts a standard person to company relation', () => {
    expect(checkCrmRelationDefinition(rel)).toEqual({ ok: true });
  });
  it('refuses many-to-many and an ambiguous self relation', () => {
    expect(checkCrmRelationDefinition({ ...rel, kind: 'many_to_many' })).toMatchObject({ code: OPS_CRM_RELATION_INVALID });
    expect(checkCrmRelationDefinition({ ...rel, toType: 'contact', toLabel: 'company' })).toMatchObject({ code: OPS_CRM_RELATION_INVALID });
  });
});

describe('records, layout and search', () => {
  it('a deal size is a decimal string, never a number', () => {
    const deal = { stage: 'TEST', size: { amount: '1000.00', currency: 'USD' }, companyId: null, expectedClose: null };
    expect(crmDealSchema.safeParse(deal).success).toBe(true);
    expect(crmDealSchema.safeParse({ ...deal, size: { amount: 1000, currency: 'USD' } }).success).toBe(false);
  });

  it('a layout refuses duplicate tab keys and empty tabs', () => {
    const tab = { key: 'main', title: 'Main', widgets: ['fields'], readOnly: false };
    const base = { recordType: 'deal', mode: 'tabs', tabs: [tab], expectedRevision: null, businessKey: 'k' };
    expect(crmLayoutSaveInputSchema.safeParse(base).success).toBe(true);
    expect(crmLayoutSaveInputSchema.safeParse({ ...base, tabs: [tab, tab] }).success).toBe(false);
    expect(crmLayoutSaveInputSchema.safeParse({ ...base, tabs: [{ ...tab, widgets: [] }] }).success).toBe(false);
  });

  it('a blank search term is too short', () => {
    expect(checkCrmSearchTerm('   ')).toMatchObject({ ok: false, code: OPS_CRM_SEARCH_TERM_TOO_SHORT });
    expect(checkCrmSearchTerm('acme')).toEqual({ ok: true });
  });

  it('search hits are typed and the total is the service count', () => {
    const out = {
      hits: [{ type: 'enquiry', recordId: '11111111-1111-4111-8111-111111111111', title: 'TEST Acme', subtitle: null }],
      total: 1,
      nextCursor: null,
    };
    expect(crmSearchOutputSchema.parse(out).total).toBe(1);
    expect(crmSearchOutputSchema.safeParse({ ...out, hits: [{ ...out.hits[0], type: 'campaign' }] }).success).toBe(false);
  });
});
