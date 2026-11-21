import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SUPPORT_CUSTOMER_PROCEDURES } from '@intafaced/contracts/support-customer-procedures';
import { NO_INPUT, type ProcedureSample, type RefusalStatus } from '@intafaced/contracts/procedure';
import { RequestFormError, type RequestForms } from './request-forms.js';
import { MemoryHelpCentreBook } from './help-centre.js';
import { createSupportRouter } from './router.js';
import { MemoryAttachmentSettingsBook } from './attachment-settings.js';
import { MemoryContactBook } from './contact-channels.js';
import { MemorySurveyBook } from './survey-settings.js';
import { unwiredApprovalConsumer } from './action-approval-consume.js';
import { MemoryKbLibraryBook } from './kb-library.js';
import { SupportError, type SupportService } from './support-service.js';

/**
 * The mounted side of each record a person's own session calls, through svc-support's whole router: each is on the
 * router at its path with the record's own input and output parsers; each sample, sent through the production adapter
 * by a signed-in caller, reaches its verdict (refused 400, accepted 200); and every refusal the record lists, thrown as
 * the error svc-support makes it from, leaves with the status it names, under the strict check that fails on a refusal
 * the record does not list. The record's zod schema and its JSON export run the same samples in `@intafaced/contracts`.
 */

const SECRET = 'a-support-customer-samples-edge-secret-long';
const USER = '33333333-3333-4333-8333-333333333333';
const TICKET = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-20T00:00:00.000Z';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });
type CustomerRecord = (typeof SUPPORT_CUSTOMER_PROCEDURES)[number];

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['support:read', 'support:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

const ticket = {
  id: TICKET,
  userId: USER,
  category: 'account',
  subject: 'Locked out',
  body: 'I cannot sign in.',
  status: 'open',
  assigneeId: null,
  createdAt: AT,
  updatedAt: AT,
};
const comment = {
  id: ATTACHMENT,
  ticketId: TICKET,
  authorId: USER,
  authorRole: 'user',
  visibility: 'public',
  body: 'Thanks',
  createdAt: AT,
};
const rating = { ticketId: TICKET, userId: USER, score: 5, note: null, createdAt: AT };
const file = {
  id: ATTACHMENT,
  ticketId: TICKET,
  ownerId: USER,
  contentType: 'image/png',
  byteLength: 6,
  scanState: 'clean',
  uploadedBy: null,
  createdAt: AT,
};
const article = { id: 'kb.password-reset', titleKey: 'kb.password-reset.title', bodyKey: 'kb.password-reset.body' };

/** What each service method answers when it answers: what makes a valid reply of its record. */
const replies: Record<string, unknown> = {
  categories: { categories: [{ id: 'account', routesTo: 'desk', refusal: null }] },
  createTicket: ticket,
  listMyTickets: [ticket],
  createdByRequest: null,
  ratedTicketIds: [TICKET],
  getTicket: ticket,
  comment,
  listComments: [comment],
  listTicketEvents: [],
  searchKb: [article],
  getKbArticle: article,
  close: { ...ticket, status: 'closed' },
  rate: rating,
  rating: null,
  attach: { ...file, storageKey: 'kept-out-of-the-wire' },
  listAttachments: [file],
  attachmentDownload: {
    id: ATTACHMENT,
    contentType: 'application/octet-stream',
    disposition: 'attachment',
    byteLength: 6,
    bodyBase64: 'aGVsbG8h',
  },
  attachmentLimits: {
    maxBytes: null,
    allowedTypes: null,
    maxCount: null,
    missing: 'support.attachment_store',
    revision: 0,
    updatedAt: null,
  },
  kbFeedback: { articleId: 'kb.password-reset', version: 1, userId: USER, helpful: true },
  kbRelated: [],
  myTicketProperties: { status: 'unset', code: 'support.customer_properties_unset' },
  catalogue: { forms: [], fields: [] },
};
/** The service method each record's handler reaches; the refusal planted there is what the handler meets. */
const METHOD: Record<CustomerRecord['path'], string> = {
  categories: 'categories',
  create: 'createTicket',
  listMine: 'listMyTickets',
  createdByRequest: 'createdByRequest',
  ratedMine: 'ratedTicketIds',
  get: 'getTicket',
  comment: 'comment',
  listComments: 'listComments',
  events: 'listTicketEvents',
  searchKb: 'searchKb',
  getKb: 'getKbArticle',
  close: 'close',
  rate: 'rate',
  rating: 'rating',
  attach: 'attach',
  ticketAttachments: 'listAttachments',
  attachmentDownload: 'attachmentDownload',
  attachmentLimits: 'attachmentLimits',
  kbFeedback: 'kbFeedback',
  kbRelated: 'kbRelated',
  myTicketProperties: 'myTicketProperties',
  requestForms: 'catalogue',
};

/** The one refusal a service method throws next, by method; none means it answers. */
const next = new Map<string, Error>();
const answer = (method: string) => {
  const planted = next.get(method);
  if (planted) throw planted;
  return replies[method];
};
const service = <T>() => new Proxy({}, { get: (_target, method: string) => async () => answer(method) }) as T;
const forms = new Proxy(
  {},
  { get: (_target, method: string) => async () => answer(method === 'check' ? 'formCheck' : method) },
) as RequestForms;
/** The help centre as published, so a public door reaches its handler. */
class PublishedHelpCentre extends MemoryHelpCentreBook {
  override async get() {
    return { ...(await super.get()), published: true };
  }
}
const helpCentre = new PublishedHelpCentre();

const supportRouter = createSupportRouter(
  service<SupportService>(),
  undefined,
  null,
  undefined,
  new MemoryContactBook(),
  new MemoryAttachmentSettingsBook(),
  new MemorySurveyBook(),
  unwiredApprovalConsumer(),
  helpCentre,
  new MemoryKbLibraryBook(),
  forms,
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

async function send(record: CustomerRecord, input: unknown) {
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

/**
 * How each refusal reaches the handler: a `SupportError` from the service, but `create`'s category refusals come from
 * the category it is sent, and its form refusals from the stored form's check.
 */
function plant(record: CustomerRecord, code: string): unknown {
  const samples: readonly ProcedureSample[] = record.samples;
  const accepted = samples.find((s) => s.verdict === 'accept')?.input as Record<string, unknown> | undefined;
  if (code === 'support.category_unknown') return { ...accepted, category: 'astrology' };
  if (code === 'support.category_guided') return { ...accepted, category: 'complaint' };
  if (code === 'support.form_unknown' || code === 'support.field_value_invalid') {
    next.set('formCheck', new RequestFormError(code, code));
    replies.createdByRequest = null;
    return { ...accepted, form: { formId: 'f', answers: [] } };
  }
  next.set(METHOD[record.path], new SupportError(code, code));
  return accepted;
}

const cases = SUPPORT_CUSTOMER_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);
const refusals = SUPPORT_CUSTOMER_PROCEDURES.flatMap((record) =>
  Object.entries(record.refusals).map(([code, status]) => ({ record, code, status, label: `${record.name} ${code}` })),
);

describe("svc-support's customer doors are mounted from their records", () => {
  it.each(SUPPORT_CUSTOMER_PROCEDURES)('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-support');
    const procedure = mounted(record.path);
    expect(procedure, `${record.path} is not on the support router`).toBeDefined();
    if (record.input !== NO_INPUT) expect(procedure!._def.inputs).toContain(record.input);
    expect(procedure!._def.output).toBe(record.output);
  });

  it.each(cases)('$label', async ({ record, sample }) => {
    const res = await send(record, sample.input);
    if (sample.verdict === 'refuse') expect(res.statusCode, res.body).toBe(400);
    else expect(res.statusCode, res.body).toBe(200);
  });

  it.each(refusals)('$label leaves with the status its record names', async ({ record, code, status }) => {
    try {
      const res = await send(record, plant(record, code));
      // A status the record does not name for this code fails the strict check as a 500, so the status is the proof.
      expect(res.statusCode, res.body).toBe(HTTP[status]);
    } finally {
      next.clear();
    }
  });

  it('a refusal the record does not list fails the strict check instead of leaving', async () => {
    next.set('getTicket', new SupportError('refused', 'support.already_rated'));
    try {
      const res = await send(
        SUPPORT_CUSTOMER_PROCEDURES.find((r) => r.path === 'get')!,
        { ticketId: TICKET },
      );
      expect(res.statusCode, res.body).toBe(500);
      expect(res.body).toContain('does not list it');
    } finally {
      next.clear();
    }
  });

  it("a stored file's store key never leaves the attach door", async () => {
    const res = await send(
      SUPPORT_CUSTOMER_PROCEDURES.find((r) => r.path === 'attach')!,
      {
        ticketId: TICKET,
        clientRequestId: 'attach:1',
        contentType: 'image/png',
        bodyBase64: 'aGVsbG8h',
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('kept-out-of-the-wire');
  });
});
