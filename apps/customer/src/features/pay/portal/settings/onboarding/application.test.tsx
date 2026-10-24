import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import type { PortalApi } from '../../api';
import type { MerchantRecord } from '../../schemas';
import { failed, noop, plain, ready } from '../account/testing';
import { applicationCopy } from './application-copy';
import type { Answers, Application, Checklist, EntityType } from './application-api';
import {
  ApplicationView,
  fileProblem,
  peopleAnswers,
  peopleComplete,
  peopleFrom,
  rolesWithoutPerson,
  stillNeeded,
  type ApplicationViewProps,
} from './Application';

// TEST DATA ONLY: the types, documents and roles stand in for what INTAFACED publishes.
const merchant: MerchantRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  mode: 'gateway',
  status: 'pending',
  kybStatus: 'none',
  kybRef: null,
  feeBps: 150,
};
const company: EntityType = {
  entityType: 'private_company',
  documentKeys: ['certificate_of_incorporation', 'proof_of_address'],
  peopleRoles: ['director', 'beneficial_owner'],
  questionnaireKeys: ['source_of_funds'],
  countries: ['DE', 'GB'],
};
const soleTrader: EntityType = {
  entityType: 'sole_proprietorship',
  documentKeys: ['proof_of_identity'],
  peopleRoles: ['proprietor'],
  questionnaireKeys: [],
  countries: ['DE'],
};
const SECTIONS = ['company_details', 'people', 'owners', 'documents', 'questionnaires'] as const;
const application = (
  patch: Partial<Application> = {},
  required: readonly string[] = ['company_details', 'people', 'documents', 'questionnaires'],
) => {
  const base: Application = {
    applicationId: 'ab000001-0000-4000-8000-000000000001',
    merchantId: merchant.id,
    entityType: 'private_company',
    country: 'DE',
    state: 'draft',
    sections: SECTIONS.map((section) => ({
      section,
      state: section === 'company_details' ? 'complete' : 'empty',
      version: section === 'company_details' ? 1 : 0,
      required: required.includes(section),
      data: (section === 'company_details' ? { legal_name: 'TEST Shop GmbH', registered_address: '1 Test Street' } : {}) as Answers,
      updatedAt: null,
    })),
    missing: ['people', 'documents', 'questionnaires'],
    kybRef: null,
    submittedAt: null,
    startedAt: '2026-10-24T06:00:00.000Z',
    dueAt: '2026-11-23T06:00:00.000Z',
  };
  return { ...base, ...patch };
};
const RULES = { maxBytes: 5 * 1024 * 1024, contentTypes: ['application/pdf', 'image/png'] };
const checklist = (rows: Checklist['rows'], rules: Checklist['uploadRules'] = RULES): Checklist => ({
  applicationId: 'ab000001-0000-4000-8000-000000000001',
  uploadRules: rules,
  rows,
  vendorCheck: { status: 'not_connected', notConnected: 'vendor.kyc' },
});
const doc = {
  id: 'ac000001-0000-4000-8000-000000000001',
  contentType: 'application/pdf',
  byteLength: 2048,
  sha256: 'a'.repeat(64),
  uploadedAt: '2026-10-24T06:10:00.000Z',
};
const base: ApplicationViewProps = {
  portal: {} as PortalApi,
  merchant,
  kybStatus: 'none',
  kybRef: null,
  types: ready([company, soleTrader]),
  application: ready(application()),
  checklist: ready(
    checklist([
      { key: 'certificate_of_incorporation', state: 'missing', rejectionReason: null, document: null },
      { key: 'proof_of_address', state: 'missing', rejectionReason: null, document: null },
    ]),
  ),
  onChanged: noop,
  reloadDocuments: noop,
  onSubmitted: noop,
  retry: noop,
  generation: 0,
};
const html = (props: Partial<ApplicationViewProps> = {}) => {
  const out = renderToString(<ApplicationView {...base} {...props} />);
  plain(out);
  return out;
};
const t = applicationCopy.t;

describe('starting the application', () => {
  it('says plainly that no business type is open while none is published', () => {
    const out = html({ types: ready([]), application: ready(null) });
    expect(out).toContain('No business types are open for verification');
    expect(out).not.toContain('Start the application');
  });
  it('offers only the published types, and the countries of the chosen one', () => {
    const out = html({ application: ready(null) });
    expect(out).toContain('Private company');
    expect(out).toContain('Sole trader');
    expect(out).not.toContain('Trust');
    expect(out).toContain('<option value="GB">GB</option>');
    expect(out).toContain('Start the application');
  });
  it('shows a refusal, not an empty form, when a read fails', () => {
    const out = html({ types: failed('pay.kyb_application_unwired', 412, 'not_mounted') });
    expect(out).not.toContain('Start the application');
  });
});

describe('a draft application', () => {
  it('is Pending, lists what is still needed by name with the due date, and cannot be sent', () => {
    const out = html();
    expect(out).toContain('Pending');
    expect(out).toContain('Still needed');
    expect(out).toContain('People behind the business');
    expect(out).toContain('Documents: Certificate of incorporation, Proof of address');
    expect(out).toContain('Questions');
    expect(out).toContain('Due by');
    expect(out).toContain('2026-11-23T06:00:00.000Z');
    expect(out).toContain('Send application for review');
    expect(out).toContain('Change the legal entity type');
  });
  it('says when no due date is published, rather than making one up', () => {
    expect(html({ application: ready(application({ dueAt: null })) })).toContain('No due date is set for applications.');
  });
  it('is Ready to send once nothing is missing', () => {
    const out = html({ application: ready(application({ missing: [] })) });
    expect(out).toContain('Ready to send');
    expect(out).toContain('Nothing. Every part is done.');
  });
  it('asks a sole trader for different documents and people than a company', () => {
    const sole = html({
      application: ready(
        application({ entityType: 'sole_proprietorship', missing: ['people', 'documents'] }, ['company_details', 'people', 'documents']),
      ),
      checklist: ready(checklist([{ key: 'proof_of_identity', state: 'missing', rejectionReason: null, document: null }])),
    });
    expect(sole).toContain('Sole trader');
    expect(sole).toContain('Proof of identity');
    expect(sole).not.toContain('Certificate of incorporation');
    expect(sole).toContain('Proprietor');
    expect(sole).not.toContain('Beneficial owner');
    expect(sole).not.toContain('Source of funds');
    const firm = html();
    expect(firm).toContain('Certificate of incorporation');
    expect(firm).toContain('Beneficial owner');
    expect(firm).toContain('Source of funds');
  });
});

describe('documents', () => {
  it('shows each row Needed, Pending, Verified or Invalid with the reason, and the published limits', () => {
    const out = html({
      checklist: ready(
        checklist([
          { key: 'certificate_of_incorporation', state: 'provided', rejectionReason: null, document: doc },
          { key: 'proof_of_address', state: 'rejected', rejectionReason: 'TEST the scan is unreadable', document: doc },
        ]),
      ),
    });
    expect(out).toContain('Pending');
    expect(out).toContain('Invalid');
    expect(out).toContain('Reason: TEST the scan is unreadable');
    expect(out).toContain('Files up to 5.0 MB. Accepted: PDF, PNG.');
    expect(out).toContain('The automatic document check isn’t connected');
    expect(out).toContain('Documents: Proof of address');
    const verified = html({
      checklist: ready(checklist([{ key: 'certificate_of_incorporation', state: 'accepted', rejectionReason: null, document: doc }])),
    });
    expect(verified).toContain('Verified');
  });
  it('refuses to take a file while no upload rules are published', () => {
    const out = html({ checklist: ready(checklist(base.checklist.status === 'ready' ? base.checklist.data!.rows : [], null)) });
    expect(out).toContain('Document uploads aren’t open');
    expect(out).not.toContain('type="file"');
  });
  it('refuses a file over the limit or of a wrong kind before it is sent, naming the limit', () => {
    expect(fileProblem({ size: 6 * 1024 * 1024, type: 'application/pdf' }, RULES, t)).toBe(
      'This file is 6.0 MB. The limit is 5.0 MB. Choose a smaller file.',
    );
    expect(fileProblem({ size: RULES.maxBytes + 1, type: 'application/pdf' }, RULES, t)).toBe(
      'This file is 5242881 B. The limit is 5242880 B. Choose a smaller file.',
    );
    expect(fileProblem({ size: 10, type: 'text/html' }, RULES, t)).toBe('This kind of file isn’t accepted. Accepted: PDF, PNG.');
    expect(fileProblem({ size: 0, type: 'application/pdf' }, RULES, t)).toBe('This file is empty. Choose another.');
    expect(fileProblem({ size: 10, type: 'IMAGE/PNG' }, RULES, t)).toBeNull();
  });
});

describe('people', () => {
  it('keeps people as named answers and back, and needs a complete person in every role', () => {
    const people = [
      { role: 'director', name: 'TEST Ana', birth_date: '1980-01-02', nationality: 'DE', ownership: '' },
      { role: 'beneficial_owner', name: 'TEST Ben', birth_date: '1975-03-04', nationality: 'GB', ownership: '60' },
    ];
    const answers = peopleAnswers(people);
    expect(answers).toMatchObject({ person_1_role: 'director', person_2_ownership: '60' });
    expect(answers).not.toHaveProperty('person_1_ownership');
    expect(peopleFrom(answers)).toEqual(people);
    expect(peopleComplete(company.peopleRoles, people)).toBe(true);
    expect(rolesWithoutPerson(company.peopleRoles, people.slice(0, 1))).toEqual(['beneficial_owner']);
    expect(peopleComplete(company.peopleRoles, [people[0]!, { ...people[1]!, nationality: 'GBR' }])).toBe(false);
    expect(peopleComplete(company.peopleRoles, [people[0]!, { ...people[1]!, ownership: '160' }])).toBe(false);
  });
});

describe('a sent application', () => {
  it('reads Sent for review, cannot be changed, and lists nothing as needed', () => {
    const out = html({
      application: ready(
        application({ state: 'submitted', missing: [], submittedAt: '2026-10-25T06:00:00.000Z', kybRef: 'application:x' }),
      ),
    });
    expect(out).toContain('Sent for review');
    expect(out).toContain('INTAFACED is reviewing your application');
    expect(out).not.toContain('Change the legal entity type');
    expect(out).not.toContain('Send application for review');
    expect(out).not.toContain('type="file"');
  });
  it('names each unfinished part, with the documents by name', () => {
    const app = application();
    const rows = checklist([{ key: 'proof_of_address', state: 'missing', rejectionReason: null, document: null }]);
    expect(stillNeeded(app, rows, t)).toEqual(['People behind the business', 'Documents: Proof of address', 'Questions']);
    expect(stillNeeded(app, null, t)).toEqual(['People behind the business', 'Documents', 'Questions']);
  });
});

describe('after the review', () => {
  const sent = application({ state: 'submitted', missing: [], submittedAt: '2026-10-25T06:00:00.000Z', kybRef: 'application:x' });
  const ref = `application:${sent.applicationId}`;
  it('a turned-down application says so and offers a new one', () => {
    const out = html({ application: ready(sent), kybStatus: 'rejected', kybRef: ref });
    expect(out).toContain('Turned down');
    expect(out).toContain('Start a new application');
    expect(out).toContain('Start the application');
  });
  it('an approved application reads Approved and offers nothing to start', () => {
    const out = html({ application: ready(sent), kybStatus: 'approved', kybRef: ref });
    expect(out).toContain('Approved');
    expect(out).not.toContain('Start the application');
  });
  it('a business verified or under review by reference is not asked to apply', () => {
    for (const kybStatus of ['pending', 'approved'] as const) {
      const out = html({ application: ready(null), kybStatus, kybRef: 'TEST-REF' });
      expect(out).toContain('no application is needed');
      expect(out).not.toContain('Start the application');
    }
  });
  it('a type that is no longer published can still be changed to one that is', () => {
    const out = html({ application: ready(application({ entityType: 'trust' })) });
    expect(out).toContain('<option value="private_company" selected="">');
    const button = /<button[^>]*>Change type<\/button>/.exec(out)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).not.toContain(' disabled=""');
  });
});
