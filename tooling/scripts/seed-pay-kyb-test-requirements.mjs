/**
 * Local TEST business verification requirements. Not production config, and not a published list.
 *
 * svc-pay ships `pay.kyb_entity_types` and `pay.kyb_upload_rules` empty, so no business application can start and no
 * document can be sent until the owner publishes them (J-merchant-02 steps 2 and 3). `local-test-gates.mjs apply` stands
 * in for that owner on the local stack with the rows below. Every key starts with `test_`, so the portal shows each one
 * as "Test …", and the countries are the ones the journeys open businesses in. A row the database already has is left
 * as it is, never overwritten. The database name must look local or test, and NODE_ENV production refuses.
 */
export { localTestDatabaseUrl } from './seed-spot-test-listing.mjs';

export const TEST_KYB_ENTITY_TYPES = Object.freeze([
  Object.freeze({
    entityType: 'private_company',
    documentKeys: ['test_certificate_of_incorporation', 'test_proof_of_address'],
    peopleRoles: ['test_director', 'test_beneficial_owner'],
    questionnaireKeys: ['test_source_of_funds'],
    countries: ['DE', 'GB'],
  }),
  Object.freeze({
    entityType: 'sole_proprietorship',
    documentKeys: ['test_proof_of_identity', 'test_proof_of_address'],
    peopleRoles: ['test_proprietor'],
    questionnaireKeys: ['test_nature_of_business'],
    countries: ['DE', 'GB'],
  }),
]);

/** The largest file and the kinds of file the stack accepts: 1 MB, PDF or PNG. */
export const TEST_KYB_UPLOAD_RULES = Object.freeze({
  maxBytes: 1024 * 1024,
  contentTypes: Object.freeze(['application/pdf', 'image/png']),
});

/** Publish the TEST types and upload rules once. Returns what was written and what was already there. */
export async function insertKybTestRequirements(sql) {
  const types = [];
  for (const t of TEST_KYB_ENTITY_TYPES) {
    const rows = await sql`
      INSERT INTO pay.kyb_entity_types (entity_type, document_keys, people_roles, questionnaire_keys, countries)
      VALUES (${t.entityType}, ${t.documentKeys}, ${t.peopleRoles}, ${t.questionnaireKeys}, ${t.countries})
      ON CONFLICT (entity_type) DO NOTHING
      RETURNING entity_type
    `;
    types.push({ entityType: t.entityType, changed: rows.length > 0 });
  }
  const rules = await sql`
    INSERT INTO pay.kyb_upload_rules (max_bytes, content_types)
    VALUES (${TEST_KYB_UPLOAD_RULES.maxBytes}, ${[...TEST_KYB_UPLOAD_RULES.contentTypes]})
    ON CONFLICT (singleton) DO NOTHING
    RETURNING max_bytes
  `;
  return { types, uploadRules: { changed: rules.length > 0 } };
}
