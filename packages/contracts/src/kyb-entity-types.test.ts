import { describe, expect, it } from 'vitest';
import {
  KYB_ENTITY_TYPES,
  kybEntityTypesViewSchema,
  kybRequirementsReadInputSchema,
  kybRequirementsViewSchema,
} from './kyb-entity-types.js';

describe('kyb entity type contracts', () => {
  it('lists the ten entity types', () => {
    expect(KYB_ENTITY_TYPES).toHaveLength(10);
  });

  it('upper-cases the country and refuses an unknown type or a malformed country', () => {
    expect(kybRequirementsReadInputSchema.parse({ entityType: 'trust', country: ' de ' })).toEqual({ entityType: 'trust', country: 'DE' });
    expect(kybRequirementsReadInputSchema.safeParse({ entityType: 'cooperative', country: 'DE' }).success).toBe(false);
    expect(kybRequirementsReadInputSchema.safeParse({ entityType: 'trust', country: 'DEU' }).success).toBe(false);
  });

  it('a published type carries at least one country, and the list may be empty', () => {
    expect(kybEntityTypesViewSchema.parse({ entityTypes: [] })).toEqual({ entityTypes: [] });
    const row = { entityType: 'trust', documentKeys: [], peopleRoles: ['grantor'], questionnaireKeys: [], countries: [] };
    expect(kybEntityTypesViewSchema.safeParse({ entityTypes: [row] }).success).toBe(false);
  });

  it('a requirements view names one country and no country list', () => {
    const view = {
      entityType: 'trust',
      country: 'DE',
      documentKeys: [],
      peopleRoles: ['grantor', 'trustee', 'beneficiary'],
      questionnaireKeys: [],
    };
    expect(kybRequirementsViewSchema.parse(view)).toEqual(view);
    expect(kybRequirementsViewSchema.safeParse({ ...view, countries: ['DE'] }).success).toBe(false);
  });
});
