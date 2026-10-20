import { z } from 'zod';

/**
 * Business verification (KYB): the entity types a business can verify as, and what each one has to provide.
 *
 * The type list is fixed here. What each type requires, and which countries it is offered in, is owner data
 * (`pay.kyb_entity_types`). A type with no published row is not offered, and asking for its requirements refuses.
 * Nothing in this file is a requirement or a country list; the keys below are only the shape a published value takes.
 */
export const KYB_ENTITY_TYPES = [
  'private_company',
  'listed_company',
  'financial_institution',
  'fund',
  'trust',
  'non_profit',
  'government_owned',
  'family_office',
  'partnership',
  'sole_proprietorship',
] as const;

export const kybEntityTypeSchema = z.enum(KYB_ENTITY_TYPES);
export type KybEntityType = z.infer<typeof kybEntityTypeSchema>;

/** A document, person role or questionnaire key the owner published, for example `director` or `certificate_of_incorporation`. */
export const kybRequirementKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);

/** ISO 3166-1 alpha-2, upper case. */
export const kybCountrySchema = z.string().regex(/^[A-Z]{2}$/);

/** What one entity type requires, as the owner published it. */
export const kybEntityTypeRequirementsSchema = z
  .object({
    entityType: kybEntityTypeSchema,
    documentKeys: z.array(kybRequirementKeySchema),
    peopleRoles: z.array(kybRequirementKeySchema),
    questionnaireKeys: z.array(kybRequirementKeySchema),
    countries: z.array(kybCountrySchema).min(1),
  })
  .strict();
export type KybEntityTypeRequirements = z.infer<typeof kybEntityTypeRequirementsSchema>;

/** `kyb.entityTypes.read`: only the published types. Empty when the owner has published none. */
export const kybEntityTypesViewSchema = z.object({ entityTypes: z.array(kybEntityTypeRequirementsSchema) }).strict();
export type KybEntityTypesView = z.infer<typeof kybEntityTypesViewSchema>;

/** `kyb.requirements.read` input. The country is normalised to upper case before it is checked. */
export const kybRequirementsReadInputSchema = z
  .object({
    entityType: kybEntityTypeSchema,
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((c) => c.toUpperCase()),
  })
  .strict();

/** `kyb.requirements.read` result: the published requirements of one type for one country it is offered in. */
export const kybRequirementsViewSchema = kybEntityTypeRequirementsSchema
  .omit({ countries: true })
  .extend({ country: kybCountrySchema })
  .strict();
export type KybRequirementsView = z.infer<typeof kybRequirementsViewSchema>;
