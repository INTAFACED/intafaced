// TEST DATA ONLY. Nothing here is a real requirement, document, person or id. The types, documents, roles, questions and
// upload rules below stand in for what INTAFACED publishes; they are not a published list.
import { createHash } from 'node:crypto';
import { NOT_MINE, DAY, MERCHANT_ID, hex, iso, ok, refuse } from '../../mock/shared.mjs';

const SECTIONS = ['company_details', 'people', 'owners', 'documents', 'questionnaires'];
const APPLICATION_ID = hex('ab', 1);

export const TEST_ENTITY_TYPES = [
  {
    entityType: 'private_company',
    documentKeys: ['certificate_of_incorporation', 'proof_of_address'],
    peopleRoles: ['director', 'beneficial_owner'],
    questionnaireKeys: ['source_of_funds'],
    countries: ['DE', 'GB'],
  },
  {
    entityType: 'sole_proprietorship',
    documentKeys: ['proof_of_identity', 'proof_of_address'],
    peopleRoles: ['proprietor'],
    questionnaireKeys: ['nature_of_business'],
    countries: ['DE'],
  },
];
export const TEST_UPLOAD_RULES = { maxBytes: 5 * 1024 * 1024, contentTypes: ['application/pdf', 'image/png', 'image/jpeg'] };

const requiredFor = (type) => [
  'company_details',
  ...(type.peopleRoles.length ? ['people'] : []),
  ...(type.documentKeys.length ? ['documents'] : []),
  ...(type.questionnaireKeys.length ? ['questionnaires'] : []),
];

/** The business application's stand-in (`kyb.entityTypes.*`, `kyb.application.*`, `kyb.documents.*`), answering like svc-pay. */
export function createApplicationMock(ctx) {
  const { scenario, now, state } = ctx;
  const typeOf = (name) => TEST_ENTITY_TYPES.find((t) => t.entityType === name);
  const fresh = (entityType, country, startedAt) => ({
    id: APPLICATION_ID,
    entityType,
    country,
    state: 'draft',
    required: requiredFor(typeOf(entityType)),
    sections: {},
    documents: {},
    submittedAt: null,
    startedAt,
  });
  // A verified business sent its application long ago; a new one has none.
  if (state.kybApplication === undefined) {
    state.kybApplication =
      scenario === 'quiet' || scenario === 'new'
        ? null
        : { ...fresh('private_company', 'GB', iso(now - 40 * DAY)), state: 'submitted', submittedAt: iso(now - 39 * DAY) };
  }
  const view = (app) => ({
    applicationId: app.id,
    merchantId: MERCHANT_ID,
    entityType: app.entityType,
    country: app.country,
    state: app.state,
    sections: SECTIONS.map((section) => {
      const saved = app.sections[section];
      return {
        section,
        state: saved ? (saved.complete ? 'complete' : 'draft') : 'empty',
        version: saved?.version ?? 0,
        required: app.required.includes(section),
        data: saved?.data ?? {},
        updatedAt: saved?.updatedAt ?? null,
      };
    }),
    missing: app.required.filter((section) => !app.sections[section]?.complete),
    kybRef: app.state === 'submitted' ? `application:${app.id}` : null,
    submittedAt: app.submittedAt,
    startedAt: app.startedAt,
    dueAt: iso(Date.parse(app.startedAt) + 30 * DAY),
  });
  const docMissing = (app) =>
    typeOf(app.entityType).documentKeys.filter((key) => !app.documents[key] || app.documents[key].state === 'rejected');
  const row = (key, doc) => ({
    key,
    state: doc?.state ?? 'missing',
    rejectionReason: doc?.rejectionReason ?? null,
    document: doc?.document ?? null,
  });
  const draft = (route, input) => {
    const app = state.kybApplication;
    if (!app || app.id !== input.applicationId) return refuse(route, 404, 'pay.kyb_application_not_found');
    if (app.state !== 'draft') return refuse(route, 412, 'pay.kyb_application_submitted');
    return app;
  };
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'kyb.entityTypes.read':
          return ok(route, { entityTypes: TEST_ENTITY_TYPES });
        case 'kyb.application.current':
          return ok(route, state.kybApplication ? view(state.kybApplication) : null);
        case 'kyb.application.start': {
          const type = typeOf(input.entityType);
          if (!type) return refuse(route, 412, 'pay.kyb_requirements_unset');
          if (!type.countries.includes(input.country)) return refuse(route, 400, 'pay.kyb_country_not_served');
          const open = state.kybApplication;
          if (open?.state === 'draft') {
            if (open.entityType !== input.entityType || open.country !== input.country)
              return refuse(route, 409, 'pay.kyb_application_exists');
            return ok(route, view(open));
          }
          const kybStatus = state.kyb?.kybStatus ?? state.merchant?.kybStatus;
          if (kybStatus === 'pending' || kybStatus === 'approved') return refuse(route, 412, 'pay.kyb_invalid');
          state.kybApplication = fresh(input.entityType, input.country, iso(Date.now()));
          return ok(route, view(state.kybApplication));
        }
        case 'kyb.application.changeType': {
          const app = draft(route, input);
          if (!app?.id) return app;
          const type = typeOf(input.entityType);
          if (!type) return refuse(route, 412, 'pay.kyb_requirements_unset');
          if (!type.countries.includes(input.country)) return refuse(route, 400, 'pay.kyb_country_not_served');
          if (app.entityType !== input.entityType || app.country !== input.country)
            state.kybApplication = fresh(input.entityType, input.country, app.startedAt);
          return ok(route, view(state.kybApplication));
        }
        case 'kyb.application.restart': {
          const app = draft(route, input);
          if (!app?.id) return app;
          state.kybApplication = fresh(app.entityType, app.country, app.startedAt);
          return ok(route, view(state.kybApplication));
        }
        case 'kyb.application.saveSection': {
          const app = draft(route, input);
          if (!app?.id) return app;
          const current = app.sections[input.section]?.version ?? 0;
          if (current !== input.expectedVersion) return refuse(route, 409, 'pay.kyb_section_version_conflict');
          if (input.section === 'documents' && input.complete && docMissing(app).length)
            return refuse(route, 412, 'pay.kyb_documents_missing');
          app.sections[input.section] = { version: current + 1, complete: input.complete, data: input.data, updatedAt: iso(Date.now()) };
          return ok(route, view(app));
        }
        case 'kyb.application.submit': {
          const app = draft(route, input);
          if (!app?.id) return app;
          if (view(app).missing.length) return refuse(route, 412, 'pay.kyb_incomplete');
          if (docMissing(app).length) return refuse(route, 412, 'pay.kyb_documents_missing');
          Object.assign(app, { state: 'submitted', submittedAt: iso(Date.now()) });
          state.merchant = state.merchant && { ...state.merchant, kybStatus: 'pending', kybRef: `application:${app.id}` };
          state.kyb = { ...(state.kyb ?? { mode: 'gateway' }), kybStatus: 'pending', kybRef: `application:${app.id}` };
          return ok(route, view(app));
        }
        case 'kyb.documents.checklist': {
          const app = state.kybApplication;
          if (!app || app.id !== input.applicationId) return refuse(route, 404, 'pay.kyb_application_not_found');
          return ok(route, {
            applicationId: app.id,
            uploadRules: TEST_UPLOAD_RULES,
            rows: typeOf(app.entityType).documentKeys.map((key) => row(key, app.documents[key])),
            vendorCheck: { status: 'not_connected', notConnected: 'vendor.kyc' },
          });
        }
        case 'kyb.documents.upload': {
          const app = draft(route, input);
          if (!app?.id) return app;
          if (!typeOf(app.entityType).documentKeys.includes(input.key)) return refuse(route, 400, 'pay.kyb_document_key_unknown');
          if (!TEST_UPLOAD_RULES.contentTypes.includes(input.contentType)) return refuse(route, 400, 'pay.kyb_document_type_refused');
          const bytes = Buffer.from(input.bytesBase64, 'base64');
          if (bytes.length > TEST_UPLOAD_RULES.maxBytes) return refuse(route, 400, 'pay.kyb_document_too_large');
          const seq = Object.keys(app.documents).length + 1;
          app.documents[input.key] = {
            state: 'provided',
            document: {
              id: hex('ac', seq),
              contentType: input.contentType,
              byteLength: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              uploadedAt: iso(Date.now()),
            },
          };
          return ok(route, { row: row(input.key, app.documents[input.key]) });
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
