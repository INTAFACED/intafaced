import type { Sql } from 'postgres';
import {
  kybEntityTypeRequirementsSchema,
  type KybEntityType,
  type KybEntityTypeRequirements,
  type KybRequirementsView,
} from '@intafaced/contracts';
import { KybError } from './kyb-service.js';

/**
 * WHAT EACH TYPE OF BUSINESS HAS TO PROVIDE TO VERIFY (I-kyc-compliance-20).
 *
 * Reads `pay.kyb_entity_types`, which is owner data: a type with no row is not offered, and nothing here supplies a
 * requirement or a country. A blank table gives an empty list, never a made-up one. This file only reads.
 */

interface EntityTypeRow {
  entity_type: KybEntityType;
  document_keys: string[];
  people_roles: string[];
  questionnaire_keys: string[];
  countries: string[];
}

function toRequirements(row: EntityTypeRow): KybEntityTypeRequirements {
  return kybEntityTypeRequirementsSchema.parse({
    entityType: row.entity_type,
    documentKeys: row.document_keys,
    peopleRoles: row.people_roles,
    questionnaireKeys: row.questionnaire_keys,
    countries: row.countries,
  });
}

export class KybEntityTypeService {
  constructor(private readonly sql: Sql) {}

  /** The published types, in a stable order. Empty when the owner has published none. */
  async list(): Promise<KybEntityTypeRequirements[]> {
    const rows = await this.sql<EntityTypeRow[]>`
      SELECT entity_type, document_keys, people_roles, questionnaire_keys, countries
        FROM pay.kyb_entity_types
       ORDER BY entity_type
    `;
    return rows.map(toRequirements);
  }

  /**
   * One type's requirements for one country. Refuses when the type has no published row
   * (`pay.kyb_requirements_unset`) or the country is not on its published list (`pay.kyb_country_not_served`).
   */
  async requirements(entityType: KybEntityType, country: string): Promise<KybRequirementsView> {
    const [row] = await this.sql<EntityTypeRow[]>`
      SELECT entity_type, document_keys, people_roles, questionnaire_keys, countries
        FROM pay.kyb_entity_types
       WHERE entity_type = ${entityType}
    `;
    if (!row) {
      throw new KybError(
        `Requirements for ${entityType} are not published. Business verification cannot start for this type until they are.`,
        'pay.kyb_requirements_unset',
        { entityType },
      );
    }
    const published = toRequirements(row);
    if (!published.countries.includes(country)) {
      throw new KybError(`${entityType} is not offered in ${country}`, 'pay.kyb_country_not_served', { entityType, country });
    }
    const { countries: _countries, ...rest } = published;
    return { ...rest, country };
  }
}
