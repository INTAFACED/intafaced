import { createHmac } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyProcedure, AnyRouter } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal, Scope } from '@intafaced/auth';
import {
  createBankScamTransferClient,
  createEdgeContext,
  encodePrincipal,
  procedureCallers,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createIdentityApprovalClient } from './action-approval-consume.js';
import { createAccountStateClient } from './account-state.js';
import { SqlAttachmentSettingsBook } from './attachment-settings.js';
import { UNCONFIGURED_ATTACHMENTS } from './attachments.js';
import { createIdentityLayoutsClient, createNotifyChartsClient } from './charts-lookup.js';
import { NO_CHAT_MAIL } from './chat-email.js';
import { SqlChatBook, SupportChat, createChatProfileClient } from './chat.js';
import { SqlContactBook } from './contact-channels.js';
import { SqlGroupBook } from './desk-groups.js';
import { DeskMacros, SqlMacroBook } from './desk-macros.js';
import { SqlPropertiesBook } from './desk-properties.js';
import { DeskRouting, SqlRoutingBook } from './desk-routing.js';
import { SqlStaffBook } from './desk-staff.js';
import { SqlViewBook } from './desk-views.js';
import { GuestRequests } from './guest-requests.js';
import { createGuestVerificationClient } from './guest-verification-client.js';
import { SqlHelpCentreBook } from './help-centre.js';
import { createSupportHttpApp } from './http-app.js';
import { KbAuthoring } from './kb-authoring.js';
import { SqlKbLibraryBook } from './kb-library.js';
import { SqlKbReviewBook } from './kb-review.js';
import { openLocalTestAttachments } from './local-test-attachments.js';
import { officialChannelsFromEnv } from './official-channels.js';
import { RatingRequestOutbox, SqlRatingRequestBook } from './rating-request.js';
import { RequestForms, SqlFormsStore } from './request-forms.js';
import { SqlResponseTargetBook } from './response-targets.js';
import { createSupportRouter } from './router.js';
import { SafetyCases, SqlSafetyBook, referenceOf } from './safety-cases.js';
import { PostgresSupportStore } from './store.js';
import { SupportService } from './support-service.js';
import { SqlSurveyBook } from './survey-settings.js';
import { createTicketKbLoopObserver } from './ticket-kb-loop-observation.js';
import { SqlLifecycleBook } from './ticket-lifecycle.js';
import { DarkTicketOrderSource } from './ticket-order.js';
import { SqlLinkBook, TicketLinks } from './ticket-links.js';
import { SqlCheckBook, VerificationChecks } from './verification-checks.js';
import { WithdrawalFreezes, createIdentityWithdrawalFreezeClient } from './withdrawal-freeze.js';

/**
 * The wire replay for svc-support: every call's current answers, recorded before anyone moves them.
 *
 * `wire-replay.golden/` holds what svc-support answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests: `/health`, `/ready` and every tRPC procedure the router `index.ts` mounts, five inputs each, four callers,
 * sent through `createSupportHttpApp` (the Fastify app `index.ts` listens on) with the edge context `index.ts` builds.
 * The router is built here as `index.ts` builds it from an empty environment: every Postgres book on a freshly migrated
 * database, every owner value blank, every outside service (identity, notify, trade, pay, bank, the event bus)
 * unreachable. A later move of these calls must answer each one byte for byte the same; a wrong scope, a changed
 * refusal code, a widened input or a reshaped envelope shows here as a difference.
 *
 * The `valid` input is made from each call's own input schema (required fields only, the first enum member, fixed ids
 * and times), so a call added or changed gets its row without a hand-kept list. Requests run in one fixed order on one
 * database, so a call that writes is seen by the calls after it.
 *
 * Ids and times the database makes are new on every run, so each is recorded by its place: a uuid the replay did not
 * choose becomes `<uuid-N>` in order of first appearance across the run, an ISO time becomes `<time>`, and a millisecond
 * count read from the clock becomes `<ms>`. tRPC's stack becomes `<stack>` and Fastify's request number `<request>`.
 *
 * The recording is split by the call's first path segment into files under the size one review part reads whole.
 * `WIRE_REPLAY_WRITE=1` rewrites the golden files (then `prettier --write` them). Only for a change that is meant to change the wire, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/**
 * Error replies no longer carry tRPC's stack. Recordings made before that hold `"stack":"<stack>"` in their error bodies;
 * it is dropped on reading, while the live side still turns any stack into `<stack>`, so a stack that comes back fails.
 */
const RECORDED_STACK = '\\"stack\\":\\"<stack>\\",';
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One golden file stays under the CI review's 400 KB diff part, so a change to it can be read. */
const FILE_CAP = 350_000;
const SECRET = 'a-support-wire-replay-edge-secret-long-enough';
const INTERNAL = 'a-support-wire-replay-internal-secret-long-enough';
/** A port nothing listens on: an outside service that is not there. */
const NOWHERE = 'http://127.0.0.1:1';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const OPERATOR = '44444444-4444-4444-8444-444444444444';
const FIXED_IDS = new Set([USER, SESSION, ID, OPERATOR]);
const NOW = '2026-11-19T00:00:00.000Z';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

let db: TestDatabase | undefined;

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is required (database name must end with _test)');
  db = await createTestDatabase({ service: 'support', url, migrations });
}, 120_000);

afterAll(async () => {
  await db?.drop();
}, 30_000);

/** The router `index.ts` builds from an empty environment, on this database. */
function build(sql: TestDatabase['sql']) {
  const attachmentSettings = new SqlAttachmentSettingsBook(sql);
  // The event bus is unreachable: rating asks stay pending, as index.ts leaves them when NATS does not answer.
  const ratingRequests = new RatingRequestOutbox(new SqlRatingRequestBook(sql), async () => null);
  const store = new PostgresSupportStore(sql);
  const accounts = createAccountStateClient(NOWHERE, INTERNAL, undefined);
  const orders = new DarkTicketOrderSource();
  const testAttachments = openLocalTestAttachments({ appEnv: 'test', store: undefined, scanner: undefined, scanDelayMs: undefined });
  const staffBook = new SqlStaffBook(sql);
  const groupBook = new SqlGroupBook(sql);
  const support = new SupportService(
    store,
    accounts,
    { ...UNCONFIGURED_ATTACHMENTS, store: testAttachments.store, scanner: testAttachments.scanner },
    staffBook,
    orders,
    null,
    undefined,
    groupBook,
    [],
    new SqlPropertiesBook(sql),
    new SqlLifecycleBook(sql),
    ratingRequests,
    attachmentSettings,
    null,
    { feedbackRateLimit: null, feedbackRateWindowSeconds: null, assistantModel: null, searchQueryMax: null },
    null,
    new SqlViewBook(sql, { personal: null, shared: null }),
    null,
    null,
  );
  const guests = new GuestRequests(
    sql,
    support,
    createGuestVerificationClient({ notifyUrl: undefined, secret: undefined, s2s: undefined }),
    {
      linkTtlMinutes: null,
      rateLimit: null,
      rateWindowSeconds: null,
      retentionDays: null,
      addressKey: null,
      publicOrigin: null,
    },
  );
  const routing = new DeskRouting(new SqlRoutingBook(sql), staffBook, groupBook, support, null, null);
  const contactBook = new SqlContactBook(sql);
  const chat = new SupportChat(
    new SqlChatBook(sql),
    support,
    createChatProfileClient(NOWHERE, INTERNAL, undefined),
    {
      rateLimit: null,
      rateWindowSeconds: null,
      identityTtlSeconds: null,
      prechatFields: [],
      addressKey: null,
      retentionDays: null,
      guestRateLimit: null,
      guestRateWindowSeconds: null,
      claimSecret: createHmac('sha256', INTERNAL).update('svc-support.chat.v1').digest('hex'),
    },
    async () => (await contactBook.get()).chatHours,
    undefined,
    NO_CHAT_MAIL,
  );
  const loop = createTicketKbLoopObserver();
  const links = new TicketLinks(new SqlLinkBook(sql), support, null, null);
  support.useRecoveryLinks(() => links.recoveryTickets());
  support.useResponseTargets(new SqlResponseTargetBook(sql));
  support.useChartsSources({
    alerts: createNotifyChartsClient({ notifyUrl: undefined, secret: undefined, s2s: undefined }),
    layouts: createIdentityLayoutsClient({ identityUrl: NOWHERE, secret: INTERNAL, s2s: undefined }),
  });
  const router = createSupportRouter(
    support,
    loop,
    INTERNAL,
    support,
    contactBook,
    attachmentSettings,
    new SqlSurveyBook(sql, undefined, null),
    createIdentityApprovalClient(NOWHERE, INTERNAL),
    new SqlHelpCentreBook(sql),
    new SqlKbLibraryBook(sql),
    new RequestForms(new SqlFormsStore(sql), { forms: null, fields: null }),
    new DeskMacros(new SqlMacroBook(sql), support, null),
    new KbAuthoring(store, new SqlKbReviewBook(sql)),
    guests,
    null,
    new VerificationChecks(new SqlCheckBook(sql), support, null),
    officialChannelsFromEnv(undefined),
    new SafetyCases(
      new SqlSafetyBook(sql),
      support,
      null,
      undefined,
      createBankScamTransferClient({ bankUrl: undefined, secret: INTERNAL, s2s: undefined }),
      null,
    ),
    chat,
    routing,
    new WithdrawalFreezes(support, createIdentityWithdrawalFreezeClient(NOWHERE, INTERNAL, undefined)),
    links,
  );
  return { router, loop };
}

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });

/** Nobody; a customer; an operator; a signed caller holding no support scope. */
const CALLERS: Array<[string, { userId: string; scopes: Scope[] } | null]> = [
  ['anon', null],
  ['customer', { userId: USER, scopes: ['support:read', 'support:write'] }],
  ['ops', { userId: OPERATOR, scopes: ['support:read', 'support:write', 'support:ops'] }],
  ['none', { userId: USER, scopes: [] }],
];

function headers(caller: (typeof CALLERS)[number][1]): Record<string, string> {
  if (caller === null) return {};
  const raw = encodePrincipal({
    sub: caller.userId,
    userId: caller.userId,
    sid: SESSION,
    scopes: caller.scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, unknown>;

/** The smallest input a JSON Schema accepts by its shape: required fields only, the first member of each choice. */
function sample(schema: Schema | undefined, defs: Record<string, Schema>, depth = 0): Json {
  if (acceptsAnyJson(schema)) return null;
  if (!schema || depth > 12) return null;
  if (typeof schema.$ref === 'string') return sample(defs[schema.$ref.split('/').pop() ?? ''], defs, depth + 1);
  if ('const' in schema) return schema.const as Json;
  if (Array.isArray(schema.enum)) return schema.enum[0] as Json;
  if ('default' in schema) return schema.default as Json;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options)) {
      const first = (options as Schema[]).find((o) => o.type !== 'null') ?? (options as Schema[])[0];
      return sample(first, defs, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf)) return sample((schema.allOf as Schema[])[0], defs, depth + 1);
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required ?? []) as string[];
      return Object.fromEntries(required.map((k) => [k, sample(properties[k], defs, depth + 1)]));
    }
    case 'array': {
      const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
      const items = Array.isArray(schema.prefixItems) ? (schema.prefixItems as Schema[]) : null;
      if (items) return items.map((item) => sample(item, defs, depth + 1));
      return Array.from({ length: min }, () => sample(schema.items as Schema, defs, depth + 1));
    }
    case 'string': {
      if (schema.format === 'uuid') return ID;
      if (schema.format === 'date-time') return NOW;
      if (schema.format === 'date') return '2026-11-19';
      if (schema.format === 'email') return 'replay@example.test';
      if (schema.format === 'uri') return 'https://example.test/';
      const min = typeof schema.minLength === 'number' ? schema.minLength : 1;
      return 'x'.repeat(Math.max(1, min));
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number'
        ? schema.minimum
        : typeof schema.exclusiveMinimum === 'number'
          ? schema.exclusiveMinimum + 1
          : 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return null;
  }
}

/** The `valid` input of a procedure, made from its own input parsers; `undefined` when it takes none. */
function validInput(inputs: readonly unknown[]): Json | undefined {
  if (inputs.length === 0) return undefined;
  const merged = inputs.map((parser) => {
    try {
      const json = z.toJSONSchema(parser as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Schema;
      return sample(json, (json.$defs ?? {}) as Record<string, Schema>);
    } catch {
      return null;
    }
  });
  if (merged.every((m) => m !== null && typeof m === 'object' && !Array.isArray(m))) return Object.assign({}, ...merged);
  return merged[0] ?? null;
}

const INPUTS = (valid: Json | undefined): Array<[string, unknown]> => [
  ['valid', valid],
  ['absent', undefined],
  ['wrong-type', 7],
  ['empty', {}],
  ['extra-key', valid !== null && typeof valid === 'object' && !Array.isArray(valid) ? { ...valid, extra: 1 } : { extra: 1 }],
];

/** Ids and times the run made, recorded by their place; see the header. */
function normalizer() {
  const seen = new Map<string, string>();
  return (body: string) =>
    body
      .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
      .replace(/"requestId":"req-[0-9a-z]+"/g, '"requestId":"<request>"')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
        if (FIXED_IDS.has(id)) return id;
        if (!seen.has(id)) seen.set(id, `<uuid-${seen.size + 1}>`);
        return seen.get(id) as string;
      })
      // A complaint, bereavement or scam reference is a hash of its request's id (`referenceOf`): recorded as that id's place.
      .replace(/\b(CP|BR|SC)-[0-9A-F]{8}\b/g, (ref, kind: 'CP' | 'BR' | 'SC') => {
        const id = [...seen.keys()].find(
          (u) => referenceOf(({ CP: 'complaint', BR: 'bereavement', SC: 'scam' } as const)[kind], u) === ref,
        );
        return id ? `${kind}-<ref of ${(seen.get(id) as string).slice(1, -1)}>` : ref;
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g, '<time>')
      .replace(/"(last\w*AtMs|ageMs)":\d+/g, '"$1":"<ms>"');
}

interface Golden {
  readonly callers: ReadonlyArray<{ path: string }>;
  readonly inputs: Record<string, unknown>;
  readonly answers: Record<string, { status: number; body: string }>;
}

async function replay(sql: TestDatabase['sql']): Promise<Golden> {
  const { router, loop } = build(sql);
  const r: AnyRouter = router;
  const procedures: Record<string, AnyProcedure> = r._def.procedures;
  const calls = Object.entries(procedures)
    .filter(([, p]) => p._def.type !== 'subscription')
    .sort(([a], [b]) => a.localeCompare(b));
  const app = await createSupportHttpApp({ router, edgeContext, serviceName: 'svc-support', identitySecret: INTERNAL, loop });
  const norm = normalizer();
  const inputs: Golden['inputs'] = {};
  const answers: Golden['answers'] = {};
  const send = async (method: 'GET' | 'POST', url: string, h: Record<string, string>, payload?: string) => {
    const res = await app.inject({
      method,
      url,
      headers: method === 'POST' ? { ...h, 'content-type': 'application/json' } : h,
      ...(method === 'POST' ? { payload: payload ?? '' } : {}),
    });
    return { status: res.statusCode, body: norm(res.body) };
  };
  try {
    for (const door of ['/health', '/ready'])
      for (const [callerName, caller] of CALLERS) answers[`${door} - ${callerName}`] = await send('GET', door, headers(caller));
    for (const [path, proc] of calls) {
      const valid = validInput(proc._def.inputs);
      inputs[path] = valid ?? null;
      const query = proc._def.type === 'query';
      for (const [inputName, input] of INPUTS(valid))
        for (const [callerName, caller] of CALLERS) {
          const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
          answers[`${path} ${inputName} ${callerName}`] = query
            ? await send('GET', url, headers(caller))
            : await send('POST', url, headers(caller), input === undefined ? '' : JSON.stringify(input));
        }
    }
    // The two plain doors again, after the calls: what the loop observer reports once tickets and articles were asked for.
    for (const door of ['/health', '/ready'])
      answers[`${door} after ops`] = await send('GET', door, headers(CALLERS.find(([name]) => name === 'ops')?.[1] ?? null));
  } finally {
    await app.close();
  }
  return { callers: procedureCallers(r), inputs, answers };
}

/** The area a recorded answer belongs to: its call's first path segment, or `doors` for /health and /ready. */
const areaOf = (key: string) => (key.startsWith('/') ? 'doors' : ((key.split(' ')[0] ?? '').split('.')[0] ?? ''));

/** The recording in files of at most FILE_CAP bytes each, by area, areas packed in order. */
function split(golden: Golden): Map<string, string> {
  const areas = [...new Set(Object.keys(golden.answers).map(areaOf))].sort();
  const write = (keep: ReadonlySet<string>) => {
    const part: Golden = {
      callers: golden.callers.filter((c) => keep.has(areaOf(c.path))),
      inputs: Object.fromEntries(Object.entries(golden.inputs).filter(([path]) => keep.has(areaOf(path)))),
      answers: Object.fromEntries(Object.entries(golden.answers).filter(([key]) => keep.has(areaOf(key)))),
    };
    return `${JSON.stringify(part, null, 2)}\n`;
  };
  const files = new Map<string, string>();
  let group: string[] = [];
  const flush = () => {
    if (group.length === 0) return;
    files.set(`${String(files.size + 1).padStart(2, '0')}-${group[0]}`, write(new Set(group)));
    group = [];
  };
  for (const area of areas) {
    if (write(new Set([...group, area])).length > FILE_CAP) flush();
    group.push(area);
  }
  flush();
  for (const [name, text] of files) if (text.length > FILE_CAP) throw new Error(`${name}: ${text.length} bytes, over FILE_CAP`);
  return files;
}

function readGolden(): Golden {
  const parts = readdirSync(GOLDEN)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(goldenJson(name.slice(0, -'.json'.length)), 'utf8').replaceAll(RECORDED_STACK, '')) as Golden);
  return {
    callers: parts.flatMap((p) => p.callers).sort((a, b) => a.path.localeCompare(b.path)),
    inputs: Object.assign({}, ...parts.map((p) => p.inputs)),
    answers: Object.assign({}, ...parts.map((p) => p.answers)),
  };
}

describe('the wire replay: svc-support answers as main did before its calls are moved', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    if (!db) throw new Error('no test database');
    const now = await replay(db.sql);
    if (process.env.WIRE_REPLAY_WRITE === '1') {
      rmSync(GOLDEN, { recursive: true, force: true });
      mkdirSync(GOLDEN);
      for (const [name, text] of split(now)) writeFileSync(goldenJson(name), text);
    }
    const golden = readGolden();
    expect(now.callers).toEqual(golden.callers);
    expect(now.inputs).toEqual(golden.inputs);
    expect(Object.keys(now.answers).sort()).toEqual(Object.keys(golden.answers).sort());
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
      .map(
        ([key, was]) =>
          `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
      );
    expect(diffs).toEqual([]);
  }, 300_000);
});

/**
 * `jsonValueSchema` (z.json()) as JSON Schema: a choice of every JSON kind. Main had `z.unknown()` there (`{}`), which
 * the sampler read as null; this reads the same, so the replay sends main's request (tooling/codemod/call-records/portable.mjs).
 */
function acceptsAnyJson(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const options = (schema as { anyOf?: unknown }).anyOf;
  if (!Array.isArray(options)) return false;
  const kinds = new Set(options.map((o: unknown) => (typeof o === 'object' && o !== null ? (o as { type?: unknown }).type : undefined)));
  return ['string', 'number', 'boolean', 'null', 'array', 'object'].every((k) => kinds.has(k));
}
