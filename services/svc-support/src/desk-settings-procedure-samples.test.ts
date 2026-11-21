import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { NO_INPUT, type ProcedureSample, type RefusalStatus } from '@intafaced/contracts/procedure';
import { SUPPORT_DESK_SETTINGS_PROCEDURES } from '@intafaced/contracts/support-desk-settings-procedures';
import type { AttachmentSettingsBook } from './attachment-settings.js';
import type { ContactBook } from './contact-channels.js';
import type { HelpCentreBook } from './help-centre.js';
import { KbAuthoringError, type KbAuthoring } from './kb-authoring.js';
import type { KbLibraryBook } from './kb-library.js';
import { createSupportRouter } from './router.js';
import { SupportError, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';
import type { VerificationChecks } from './verification-checks.js';

/**
 * The mounted side of each desk settings record, through svc-support's whole router. Its path is on the router with the
 * record's own input and output parsers; each sample, sent through the production adapter by a desk operator, reaches its
 * verdict (a refused sample is answered 400, an accepted one 200); and every refusal the record lists, thrown as the
 * typed error svc-support makes it from, leaves with the status it names, under the strict check that fails on a refusal
 * the record does not list. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`
 * (`procedure-registry.test.ts`).
 */

const SECRET = 'a-support-desk-settings-samples-edge-secret';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-20T00:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });
type DeskRecord = (typeof SUPPORT_DESK_SETTINGS_PROCEDURES)[number];

function signedIn(): Record<string, string> {
  const principal = {
    sub: OPERATOR,
    userId: OPERATOR,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['support:ops', 'support:read', 'support:write'],
    tier: 'none',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const limits = { maxBytes: 1_000_000, allowedTypes: ['image/png'], maxCount: 5, missing: null, revision: 1, updatedAt: AT };
const draft = {
  id: 'card-limits',
  revision: 2,
  state: 'draft',
  authorId: OPERATOR,
  templateId: null,
  title: 'Card limits',
  body: 'How limits work.',
  language: 'en',
  sectionId: 'cards',
  tags: [],
  audience: 'public',
  createdAt: AT,
};
const template = { id: 'fees', name: 'Fees', body: 'What it costs.', revision: 1, retired: false, updatedAt: AT };
const channels = { email: null, phone: null, chatHours: 'Mon to Fri, 09:00 to 17:00 UTC', revision: 1, updatedAt: AT };
const file = {
  id: FILE,
  ticketId: TICKET,
  ownerId: TICKET,
  contentType: 'image/png',
  byteLength: 2,
  scanState: 'clean',
  uploadedBy: OPERATOR,
  createdAt: AT,
};
const check = { ticketId: TICKET, kind: 'client_order_id', matched: true, checkedBy: OPERATOR, checkedAt: AT };

/** What each part's method answers when it answers, by `<part>.<method>`: what makes a valid reply of its record. */
const replies: Record<string, unknown> = {
  'support.listKbVisible': [],
  'support.listStaff': [{ userId: OPERATOR, role: 'lead' }],
  'support.attachmentStatus': {
    pieces: [
      'support.attachment_store',
      'support.malware_scanner',
      'support.attachment_max_bytes',
      'support.attachment_allowed_types',
      'support.attachment_max_count',
    ].map((key) => ({ key, set: true })),
    limits,
  },
  'support.attachmentLimits': limits,
  'support.attachAsOperator': { ...file, storeKey: 'internal' },
  'support.attachmentDownload': {
    id: FILE,
    contentType: 'application/octet-stream',
    disposition: 'attachment',
    byteLength: 2,
    bodyBase64: 'aGk=',
  },
  'library.categories': [{ id: 'cards-help', name: 'Cards', position: 1, retired: false }],
  'library.sections': [{ id: 'cards', categoryId: 'cards-help', name: 'Limits', position: 1, retired: false }],
  'library.section': { id: 'cards', categoryId: 'cards-help', name: 'Limits', position: 1, retired: false },
  'helpCentre.get': {
    name: null,
    address: null,
    defaultLanguage: null,
    languages: null,
    setupMode: null,
    theme: null,
    published: null,
    revision: 0,
    updatedAt: null,
  },
  'helpCentre.listTranslations': { languages: null, total: null, rows: [] },
  'contact.get': channels,
  'contact.set': channels,
  'attachments.set': undefined,
  'authoring.saveDraft': draft,
  'authoring.draft': draft,
  'authoring.history': { id: 'card-limits', versions: [], trail: [] },
  'authoring.submit': draft,
  'authoring.approve': draft,
  'authoring.sendBack': draft,
  'authoring.publish': { id: 'card-limits', titleKey: 'support.kb.stored.title', bodyKey: 'support.kb.stored.body' },
  'authoring.listTemplates': [template],
  'authoring.saveTemplate': template,
  'checks.record': check,
  'checks.list': { required: 2, matched: 1, attemptsAllowed: 5, attemptsUsed: 1, checks: [check] },
};
/** The part and method each record's handler reaches last; the refusal planted there is what the handler meets. */
const METHOD: Record<DeskRecord['path'], string> = {
  kbLibrary: 'support.listKbVisible',
  kbTemplates: 'authoring.listTemplates',
  kbHistory: 'authoring.history',
  kbDraft: 'authoring.draft',
  kbSaveDraft: 'authoring.saveDraft',
  kbSubmitForReview: 'authoring.submit',
  kbApprove: 'authoring.approve',
  kbSendBack: 'authoring.sendBack',
  kbPublishDraft: 'authoring.publish',
  kbSaveTemplate: 'authoring.saveTemplate',
  attachOps: 'support.attachAsOperator',
  attachmentDownloadOps: 'support.attachmentDownload',
  verificationChecks: 'checks.list',
  recordVerificationCheck: 'checks.record',
  readDisclosure: 'checks.disclose',
  attachmentStatus: 'support.attachmentStatus',
  setAttachmentSettings: 'support.attachmentLimits',
  contactChannels: 'contact.get',
  setContactChannels: 'contact.set',
  helpCentre: 'helpCentre.get',
  helpCentreTranslations: 'helpCentre.listTranslations',
};

/** The typed error svc-support makes each refusal from: help article moves from `KbAuthoringError`, the rest a `SupportError`. */
function typedError(code: string): Error {
  return code.startsWith('support.kb_') ? new KbAuthoringError(code) : new SupportError(`refused: ${code}`, code);
}

/** The one refusal a part throws next, by `<part>.<method>`; none means it answers. */
const next = new Map<string, Error>();
const answer = (key: string) => {
  const planted = next.get(key);
  if (planted) throw planted;
  // A read behind the gate has no answer: it always refuses, as `VerificationChecks.disclose` does.
  if (key === 'checks.disclose') throw new SupportError('refused', 'support.verification_checks_required');
  return replies[key];
};
const part = <T>(name: string) =>
  new Proxy({}, { get: (_target, method: string) => (method === 'then' ? undefined : async () => answer(`${name}.${method}`)) }) as T;

const u = undefined;
const supportRouter = createSupportRouter(
  part<SupportService>('support'),
  u,
  u,
  u,
  part<ContactBook>('contact'),
  part<AttachmentSettingsBook>('attachments'),
  u,
  u,
  part<HelpCentreBook>('helpCentre'),
  part<KbLibraryBook>('library'),
  u,
  u,
  part<KbAuthoring>('authoring'),
  u,
  u,
  part<VerificationChecks>('checks'),
);
const app = Fastify();

beforeAll(async () => {
  vi.stubEnv('PROCEDURE_REFUSALS_STRICT', '1');
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: supportRouter, createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

async function send(record: DeskRecord, input: unknown) {
  const url = `/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  return record.kind === 'query'
    ? app.inject({ method: 'GET', url, headers: signedIn() })
    : app.inject({
        method: 'POST',
        url,
        headers: { ...signedIn(), 'content-type': 'application/json' },
        payload: input === undefined ? '' : JSON.stringify(input),
      });
}

type Mounted = { _def: { inputs: unknown[]; output?: unknown } };
const mounted = (path: string): Mounted | undefined =>
  (Reflect.get(Reflect.get(supportRouter, '_def') as object, 'procedures') as Record<string, Mounted>)[path];

const HTTP: Record<RefusalStatus, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
  TIMEOUT: 408,
};

const cases = SUPPORT_DESK_SETTINGS_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);
const refusals = SUPPORT_DESK_SETTINGS_PROCEDURES.flatMap((record) =>
  Object.entries(record.refusals).map(([code, status]) => ({ record, code, status, label: `${record.name} ${code}` })),
);

describe("svc-support's desk settings routes are mounted from their records", () => {
  it.each(SUPPORT_DESK_SETTINGS_PROCEDURES)('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-support');
    const procedure = mounted(record.path);
    expect(procedure, `${record.path} is not on the support router`).toBeDefined();
    if (record.input === NO_INPUT) expect(procedure!._def.inputs).toEqual([]);
    else expect(procedure!._def.inputs).toContain(record.input);
    expect(procedure!._def.output).toBe(record.output);
  });

  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    // A read behind the gate takes the input and refuses by its code: it has no success answer.
    else if (record.path === 'readDisclosure') expect(res.statusCode, res.body).toBe(412);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(refusals)('$label leaves with the status its record names', async ({ record, code, status }) => {
    const accepted: ProcedureSample = record.samples.find((s: ProcedureSample) => s.verdict === 'accept')!;
    next.set(METHOD[record.path], typedError(code));
    try {
      const res = await send(record, accepted.input);
      // A help article refusal is sent as its code; every other in its words (`userCopy`), which name it or not.
      const words = code.startsWith('support.kb_') ? code : userCopy(code);
      expect((JSON.parse(res.body) as { error: { message: string } }).error.message).toBe(words);
      expect(res.statusCode, res.body).toBe(HTTP[status]);
    } finally {
      next.clear();
    }
  });

  it('a refusal the record does not list fails the strict check instead of leaving', async () => {
    next.set('support.attachmentDownload', new SupportError('refused', 'support.not_lead'));
    try {
      const res = await send(
        SUPPORT_DESK_SETTINGS_PROCEDURES.find((r) => r.path === 'attachmentDownloadOps')!,
        { attachmentId: FILE },
      );
      expect(res.statusCode, res.body).toBe(500);
      expect(res.body).toContain('does not list it');
    } finally {
      next.clear();
    }
  });

  it('the store key of a file never leaves with it', async () => {
    const res = await send(
      SUPPORT_DESK_SETTINGS_PROCEDURES.find((r) => r.path === 'attachOps')!,
      {
        ticketId: TICKET,
        clientRequestId: 'admin-attach:1',
        contentType: 'image/png',
        bodyBase64: 'aGk=',
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('internal');
  });
});
