// The support desk's parity cases (`record-factories.mjs`): every `support.*` call under blank, partial and published
// laws, every refusal reachable without a session, and the metered run's free outcomes before any session. A case's
// `port` is one reply of svc-support (or svc-identity), served to the real HTTP desk port by a fake fetch (`{ status,
// body }`, or `{ throws: true }`; `identity: false` builds the port without `IDENTITY_URL`).
//
// It also keeps `src/factories/support_schemas.json`: the three wire shapes the desk port reads (`supportKbArticleSchema`,
// `supportTicketSchema`, `accountStateSchema`), as the tree of zod parts the kit's zod engine runs. The recorder writes
// it; `--check` fails while it is stale.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SVC = fileURLToPath(new URL('../../../../services/svc-agents/src/', import.meta.url));
const fromService = createRequire(`${SVC}index.ts`);
const contracts = await import(pathToFileURL(fromService.resolve('@intafaced/contracts')).href);

// ── The wire shapes, as the kit's zod engine reads them ─────────────────────────────────────────────────────────────

const ids = new Map();
const nodes = [];
const node = (s) => {
  if (ids.has(s)) return ids.get(s);
  const id = nodes.length;
  ids.set(s, id);
  nodes.push(null);
  nodes[id] = build(s);
  return id;
};
function messageOf(def) {
  if (!def.error) return undefined;
  const m = def.error({});
  return typeof m === 'string' ? m : m?.message;
}
function check(c) {
  const d = c._zod.def;
  if (d.when && !(['min_length', 'max_length'].includes(d.check) && d.when.toString().includes('val.length !== undefined'))) {
    throw new Error(`support schemas: a check with its own when (${d.check})`);
  }
  const out = (k, extra = {}) => {
    const msg = messageOf(d);
    return { k, ...extra, ...(d.abort ? { abort: true } : {}), ...(msg !== undefined ? { msg } : {}) };
  };
  switch (d.check) {
    case 'min_length':
      return out('min_length', { n: d.minimum });
    case 'max_length':
      return out('max_length', { n: d.maximum });
    case 'string_format':
      if (['guid', 'uuid', 'datetime'].includes(d.format)) return out('format', { format: d.format, src: d.pattern.toString() });
      throw new Error(`support schemas: string format ${d.format}`);
    case 'greater_than':
      return out('gt', { v: d.value, incl: d.inclusive });
    case 'less_than':
      return out('lt', { v: d.value, incl: d.inclusive });
    case 'number_format':
      if (d.format !== 'safeint') throw new Error(`support schemas: number format ${d.format}`);
      return out('int');
    default:
      throw new Error(`support schemas: check ${d.check}`);
  }
}
function build(s) {
  const d = s._zod.def;
  if (d.error) throw new Error(`support schemas: a ${d.type} with its own error`);
  const self = s._zod.traits.has('$ZodCheck') && d.type === 'string' ? [s] : [];
  const checks = [...self, ...(d.checks ?? [])].map(check);
  const withChecks = (o) => (checks.length ? { ...o, checks } : o);
  switch (d.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return withChecks({ t: d.type });
    case 'enum':
      return withChecks({ t: 'enum', values: s.options });
    case 'object':
      if (d.catchall) throw new Error('support schemas: an object with a catchall');
      return withChecks({ t: 'object', shape: Object.entries(d.shape).map(([k, v]) => [k, node(v)]) });
    case 'array':
      return withChecks({ t: 'array', el: node(d.element) });
    case 'optional':
    case 'nullable':
      return withChecks({ t: d.type, in: node(d.innerType) });
    default:
      throw new Error(`support schemas: schema type ${d.type}`);
  }
}
const roots = {
  article: node(contracts.supportKbArticleSchema),
  ticket: node(contracts.supportTicketSchema),
  account: node(contracts.accountStateSchema),
};
const SCHEMAS = fileURLToPath(new URL('../../src/factories/support_schemas.json', import.meta.url));
const PRETTIER = fileURLToPath(new URL('../../../../node_modules/.bin/prettier', import.meta.url));
const text = execFileSync(PRETTIER, ['--stdin-filepath', SCHEMAS], {
  input: `${JSON.stringify({ nodes, roots })}\n`,
  encoding: 'utf8',
});
if (process.argv.includes('--check')) {
  let was = '';
  try {
    was = readFileSync(SCHEMAS, 'utf8');
  } catch {}
  if (was !== text) {
    console.error('stale: crates/svc-agents/src/factories/support_schemas.json');
    process.exitCode = 1;
  }
} else {
  writeFileSync(SCHEMAS, text);
}

// ── The laws ────────────────────────────────────────────────────────────────────────────────────────────────────────

const KB = 'support.kb.search';
const TICKET = 'support.ticket.read';
const ACCOUNT = 'identity.account.read';
const law = (matrix) => JSON.stringify({ support: { published: true, matrix } });
const ALL = law({ basic: [KB, TICKET, ACCOUNT] });
const KB_ONLY = law({ basic: [KB] });
const NO_KB = law({ basic: [TICKET, ACCOUNT] });
const WIDE = law({ basic: [KB, TICKET, ACCOUNT, 'pay.refund', 'support.ticket.comment', 'support.unknown'] });
const OTHER = law({ full: [KB, TICKET, ACCOUNT] });
const EMPTY = law({});
const NONE_GRANTED = law({ basic: [] });
const UNPUBLISHED = JSON.stringify({ support: { published: false } });

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const TICKET_ID = '55555555-5555-4555-8555-555555555555';
const STAMP = '2026-11-18T10:00:00.000Z';

const ARTICLE = {
  articleKey: 'support.kb.withdrawal_hold',
  titleKey: 'support.kb.withdrawal_hold.title',
  bodyKey: 'support.kb.withdrawal_hold.body',
};
const KB_ROW = {
  id: 'support.kb.withdrawal_hold',
  titleKey: 'support.kb.withdrawal_hold.title',
  bodyKey: 'support.kb.withdrawal_hold.body',
};
const KB_ROW2 = { id: 'kb-account-access', titleKey: 'support.kb.account_access.title', bodyKey: 'support.kb.account_access.body' };
const ticketRow = (over = {}) => ({
  id: TICKET_ID,
  userId: USER,
  category: 'deposit_withdraw',
  subject: 'Where is my withdrawal?',
  body: 'It has been pending for a day.',
  status: 'open',
  assigneeId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});
const accountRow = (over = {}) => ({ userId: USER, status: 'active', kycTier: 'basic', ...over });
const TICKET_INPUT = { ticketId: TICKET_ID, ownerUserId: USER, status: 'open', category: 'withdrawal' };

const ok = (body) => ({ status: 200, body });
const trpc = (data) => ok({ result: { data } });

// ── The cases ───────────────────────────────────────────────────────────────────────────────────────────────────────

const draft = (name, input) => ({ name: `draftComment: ${name}`, path: 'support.draftComment', input });
const grounded = (name, input) => ({ name: `grounded: ${name}`, path: 'support.grounded', input });
const tool = (name, input, laws = ALL, extra = {}) => ({
  name: `invokeDataTool: ${name}`,
  path: 'support.invokeDataTool',
  input,
  laws,
  ...extra,
});
const answer = (name, input, laws = ALL, extra = {}) => ({
  name: `answerOrEscalate: ${name}`,
  path: 'support.answerOrEscalate',
  input,
  laws,
  ...extra,
});
const run = (name, input, laws = ALL, extra = {}) => ({ name: `runSession: ${name}`, path: 'support.runSession', input, laws, ...extra });

const kbAsk = { tool: KB, limit: 20, articles: [ARTICLE] };
const accountAsk = { tool: ACCOUNT, account: { userId: USER, status: 'active', kycTier: 'basic' } };
const ticketAsk = { tool: TICKET, ticket: TICKET_INPUT };

export const cases = [
  { name: 'policy', path: 'support.policy' },
  { name: 'stage1Guardrail', path: 'support.stage1Guardrail' },

  { name: 'tierGate: no law', path: 'support.tierGate', input: {} },
  { name: 'tierGate: unpublished', path: 'support.tierGate', input: {}, laws: UNPUBLISHED },
  { name: 'tierGate: empty matrix', path: 'support.tierGate', input: {}, laws: EMPTY },
  { name: 'tierGate: granted', path: 'support.tierGate', input: {}, laws: ALL },
  { name: 'tierGate: granted nothing', path: 'support.tierGate', input: {}, laws: NONE_GRANTED },
  { name: 'tierGate: another tier', path: 'support.tierGate', input: {}, laws: OTHER },
  { name: 'tierGate: no tier', path: 'support.tierGate', input: {}, laws: ALL, tier: '' },
  { name: 'tierGate: a padded tier', path: 'support.tierGate', input: {}, laws: ALL, tier: ' basic ' },
  { name: 'tierGate: a stray key', path: 'support.tierGate', input: { tier: 'basic' }, laws: ALL },

  draft('ok', { ticketId: 'tkt-1', body: 'We are looking into it.' }),
  draft('padded', { ticketId: '  tkt-1 ', body: '\n  We are looking into it.\t' }),
  draft('no ticket', { body: 'Hello' }),
  draft('null ticket', { ticketId: null, body: 'Hello' }),
  draft('blank ticket', { ticketId: '   ', body: 'Hello' }),
  draft('no body', { ticketId: 'tkt-1' }),
  draft('null body', { ticketId: 'tkt-1', body: null }),
  draft('blank body', { ticketId: 'tkt-1', body: '    ' }),
  draft('4000 characters', { ticketId: 'tkt-1', body: 'a'.repeat(4000) }),
  draft('4001 characters', { ticketId: 'tkt-1', body: 'a'.repeat(4001) }),
  draft('4000 characters padded', { ticketId: 'tkt-1', body: ` ${'a'.repeat(4000)} ` }),
  draft('2000 astral characters', { ticketId: 'tkt-1', body: '😀'.repeat(2000) }),
  draft('2001 astral characters', { ticketId: 'tkt-1', body: '😀'.repeat(2001) }),
  draft('over the input cap', { ticketId: 'tkt-1', body: 'a'.repeat(5001) }),
  draft('I refunded', { ticketId: 'tkt-1', body: 'Good news, I refunded you.' }),
  draft('I have refunded', { ticketId: 'tkt-1', body: 'I HAVE REFUNDED the fee' }),
  draft('balance is', { ticketId: 'tkt-1', body: 'Your balance is 100 now' }),
  draft('balance now', { ticketId: 'tkt-1', body: 'balance now 5' }),
  draft('balance is a word', { ticketId: 'tkt-1', body: 'your balance is fine' }),
  draft('credited', { ticketId: 'tkt-1', body: 'We credited $50' }),
  draft('wired', { ticketId: 'tkt-1', body: 'wired 10 to you' }),
  draft('sent you', { ticketId: 'tkt-1', body: 'We Sent You $3.' }),
  draft('payout of', { ticketId: 'tkt-1', body: 'A payout of value' }),
  draft('inside a word', { ticketId: 'tkt-1', body: 'xpayout of' }),
  draft('a digit after', { ticketId: 'tkt-1', body: 'credited 5x' }),
  draft('a dotless i', { ticketId: 'tkt-1', body: 'ı refunded' }),

  grounded('dark', { plane: 'dark' }),
  grounded('dark, KB live', { plane: 'dark', kbPlane: 'live', kbHitCount: 3, requireKb: true }),
  grounded('live', { plane: 'live' }),
  grounded('KB dark', { plane: 'live', kbPlane: 'dark' }),
  grounded('KB live', { plane: 'live', kbPlane: 'live' }),
  grounded('KB required, no count', { plane: 'live', requireKb: true }),
  grounded('KB required, none', { plane: 'live', requireKb: true, kbHitCount: 0 }),
  grounded('KB required, hits', { plane: 'live', requireKb: true, kbHitCount: 3 }),
  grounded('KB not required, none', { plane: 'live', requireKb: false, kbHitCount: 0 }),
  grounded('a fraction', { plane: 'live', kbHitCount: 1.5 }),

  tool('a money tool', { tool: 'ledger.post', plane: 'live' }),
  tool('a padded money tool', { tool: ' pay.refund ', plane: 'live' }),
  tool('a live write', { tool: 'trade.place', plane: 'dark' }),
  tool('dark', { tool: KB, plane: 'dark', limit: 5 }),
  tool('KB dark', { tool: KB, plane: 'live', kbPlane: 'dark', limit: 5 }),
  tool('no law', { tool: KB, plane: 'live', limit: 5 }, null),
  tool('unpublished', { tool: KB, plane: 'live', limit: 5 }, UNPUBLISHED),
  tool('empty matrix', { tool: KB, plane: 'live', limit: 5 }, EMPTY),
  tool('another tier', { tool: KB, plane: 'live', limit: 5 }, OTHER),
  tool('no tier', { tool: KB, plane: 'live', limit: 5 }, ALL, { tier: ' ' }),
  tool('undeclared', { tool: 'support.unknown', plane: 'live' }, WIDE),
  tool('declared, not a data tool', { tool: 'support.ticket.comment', plane: 'live' }, WIDE),
  tool('not in tier', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, KB_ONLY),
  tool('live, no port', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5, articles: [ARTICLE] }),
  tool('live, no port, a stamp', { tool: ACCOUNT, plane: 'live', occurredAt: '2026-11-18T09:00:00Z' }),
  tool('a stray key', { tool: KB, plane: 'live', limit: 5, requester: OTHER_USER }),
  ...[
    ['search: no page size', { tool: KB, plane: 'live' }, ok([KB_ROW])],
    ['search: ok', { tool: KB, plane: 'live', limit: 5 }, ok([KB_ROW, KB_ROW2])],
    ['search: wrapped', { tool: KB, plane: 'live', limit: 5 }, trpc([KB_ROW])],
    ['search: wrapped json', { tool: KB, plane: 'live', limit: 5 }, trpc({ json: [KB_ROW] })],
    ['search: wrapped null', { tool: KB, plane: 'live', limit: 5 }, trpc(null)],
    [
      'search: extra fields',
      { tool: KB, plane: 'live', limit: 5 },
      ok([{ ...KB_ROW, version: 2, published: true, tags: ['a'], secret: 'x' }]),
    ],
    ['search: none', { tool: KB, plane: 'live', limit: 5 }, ok([])],
    ['search: a sentence', { tool: KB, plane: 'live', limit: 5 }, ok([{ ...KB_ROW, bodyKey: 'Your money is safe' }])],
    ['search: a padded key', { tool: KB, plane: 'live', limit: 5 }, ok([{ ...KB_ROW, titleKey: ' support.kb.x ' }])],
    ['search: one segment', { tool: KB, plane: 'live', limit: 5 }, ok([{ ...KB_ROW, id: 'withdrawals' }])],
    ['search: a blank id', { tool: KB, plane: 'live', limit: 5 }, ok([{ ...KB_ROW, id: '' }])],
    ['search: version 0', { tool: KB, plane: 'live', limit: 5 }, ok([{ ...KB_ROW, version: 0 }])],
    ['search: a bad audience', { tool: KB, plane: 'live', limit: 5 }, ok([{ ...KB_ROW, audience: 'nobody' }])],
    ['search: an object', { tool: KB, plane: 'live', limit: 5 }, ok({ articles: [KB_ROW] })],
    ['search: 500', { tool: KB, plane: 'live', limit: 5 }, { status: 500, body: [KB_ROW] }],
    ['search: down', { tool: KB, plane: 'live', limit: 5 }, { throws: true }],
    ['ticket: no ticket', { tool: TICKET, plane: 'live' }, ok(ticketRow())],
    ['ticket: a blank id', { tool: TICKET, plane: 'live', ticket: { ...TICKET_INPUT, ticketId: '  ' } }, ok(ticketRow())],
    ['ticket: ok', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, ok(ticketRow())],
    ['ticket: padded id', { tool: TICKET, plane: 'live', ticket: { ...TICKET_INPUT, ticketId: ` ${TICKET_ID} ` } }, ok(ticketRow())],
    ['ticket: wrapped', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, trpc({ json: ticketRow({ status: 'resolved' }) })],
    [
      'ticket: optional fields',
      { tool: TICKET, plane: 'live', ticket: TICKET_INPUT },
      ok(ticketRow({ messageHeaders: null, mergedInto: null, customerStatus: 'open' })),
    ],
    ['ticket: somebody else', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, ok(ticketRow({ userId: OTHER_USER }))],
    ['ticket: another id', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, ok(ticketRow({ id: OTHER_USER }))],
    ['ticket: not a guid', { tool: TICKET, plane: 'live', ticket: { ...TICKET_INPUT, ticketId: 'tkt-1' } }, ok(ticketRow({ id: 'tkt-1' }))],
    ['ticket: a bad status', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, ok(ticketRow({ status: 'lost' }))],
    ['ticket: a bad time', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, ok(ticketRow({ updatedAt: 'yesterday' }))],
    ['ticket: a blank subject', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, ok(ticketRow({ subject: '' }))],
    ['ticket: 404', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, { status: 404, body: { error: 'missing' } }],
    ['ticket: 401', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, { status: 401, body: {} }],
    ['ticket: down', { tool: TICKET, plane: 'live', ticket: TICKET_INPUT }, { throws: true }],
    ['account: ok', { tool: ACCOUNT, plane: 'live' }, ok(accountRow())],
    ['account: archived, frozen', { tool: ACCOUNT, plane: 'live' }, ok(accountRow({ status: 'frozen', archived: false }))],
    ['account: a money field', { tool: ACCOUNT, plane: 'live' }, ok(accountRow({ balance: '100', availableBalance: '5' }))],
    ['account: somebody else', { tool: ACCOUNT, plane: 'live' }, ok(accountRow({ userId: OTHER_USER }))],
    ['account: a bad tier', { tool: ACCOUNT, plane: 'live' }, ok(accountRow({ kycTier: 'tier2' }))],
    ['account: 404', { tool: ACCOUNT, plane: 'live' }, { status: 404, body: {} }],
    ['account: down', { tool: ACCOUNT, plane: 'live' }, { throws: true }],
    ['account: no identity', { tool: ACCOUNT, plane: 'live' }, { ...ok(accountRow()), identity: false }],
  ].map(([name, input, port]) => tool(`desk, ${name}`, input, ALL, { port })),

  answer('a money request', { tool: KB, plane: 'live', moneyRequest: true, limit: 5 }),
  answer('dark', { tool: KB, plane: 'dark', limit: 5 }),
  answer('KB omitted is dark', { tool: KB, plane: 'live', limit: 5, articles: [ARTICLE] }),
  answer('live, no port', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5, articles: [ARTICLE] }),
  answer('no law', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5 }, null),
  answer('a money tool', { tool: 'pay.refund', plane: 'live', kbPlane: 'live' }),
  answer('moneyRequest false', { tool: KB, plane: 'live', kbPlane: 'dark', moneyRequest: false }),
  ...[
    ['hits', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5 }, ok([KB_ROW, KB_ROW2])],
    ['a money request with hits', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5, moneyRequest: true }, ok([KB_ROW])],
    ['no hits', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5 }, ok([])],
    ['no page size', { tool: KB, plane: 'live', kbPlane: 'live' }, ok([KB_ROW])],
    ['the desk down', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5 }, { throws: true }],
    ['a sentence', { tool: KB, plane: 'live', kbPlane: 'live', limit: 5 }, ok([{ ...KB_ROW, titleKey: 'Hello there' }])],
    ['an account read', { tool: ACCOUNT, plane: 'live', kbPlane: 'live' }, ok(accountRow())],
    ['a ticket read', { tool: TICKET, plane: 'live', kbPlane: 'live' }, ok(ticketRow())],
  ].map(([name, input, port]) => answer(`desk, ${name}`, input, ALL, { port })),

  run('dark', { plane: 'dark', asks: [kbAsk] }),
  run('dark, a money request', { plane: 'dark', moneyRequest: true, asks: [kbAsk] }),
  run('a money request', { plane: 'live', moneyRequest: true, asks: [kbAsk, accountAsk] }, null),
  run('moneyRequest false', { plane: 'live', moneyRequest: false, asks: [kbAsk] }, null),
  run('no law', { plane: 'live', kbCatalog: [KB_ROW], asks: [kbAsk] }, null),
  run('unpublished', { plane: 'live', kbCatalog: [KB_ROW], asks: [kbAsk] }, UNPUBLISHED),
  run('empty matrix', { plane: 'live', kbCatalog: [KB_ROW], asks: [kbAsk] }, EMPTY),
  run('another tier', { plane: 'live', kbCatalog: [KB_ROW], asks: [kbAsk] }, ALL, { tier: 'none' }),
  run('no catalog', { plane: 'live', asks: [kbAsk, accountAsk] }),
  run('a null catalog', { plane: 'live', kbCatalog: null, asks: [{ tool: KB, kbQuery: 'withdrawal-hold', limit: 20 }] }),
  run('an empty catalog', { plane: 'live', kbCatalog: [], asks: [{ tool: ` ${KB} `, kbQuery: 'account', limit: 20 }] }),
  run('nothing asked', { plane: 'live', kbCatalog: [KB_ROW], asks: [] }),
  run('nothing asked, no catalog', { plane: 'live', asks: [] }),
  run('live, no port', { plane: 'live', kbCatalog: [KB_ROW], asks: [kbAsk, accountAsk] }),
  run('live, no port, no KB ask', { plane: 'live', asks: [accountAsk] }),
  run('a key may not run', { plane: 'dark', asks: [kbAsk] }, ALL, { scopes: ['agents:read'] }),
  run('a body naming its tier', { plane: 'live', asks: [kbAsk], userTier: 'basic' }),
  run('a body naming its law', { plane: 'live', asks: [kbAsk], law: { published: true } }),
  run('21 asks', { plane: 'dark', asks: Array.from({ length: 21 }, () => kbAsk) }),
  run('a bad grounding', {
    plane: 'dark',
    asks: [{ tool: ACCOUNT, accountGrounding: { status: 'read', state: accountRow({ userId: 'u1' }), readAt: STAMP } }],
  }),
  ...[
    ['no tool granted', { plane: 'live', kbCatalog: [KB_ROW], asks: [ticketAsk, accountAsk] }, KB_ONLY],
    ['nothing granted', { plane: 'live', kbCatalog: [KB_ROW], asks: [kbAsk] }, NONE_GRANTED],
    ['a padded grant miss', { plane: 'live', kbCatalog: [KB_ROW], asks: [{ tool: ' support.unknown ' }] }, ALL],
    ['no KB ask', { plane: 'live', asks: [accountAsk, ticketAsk] }, ALL],
    ['no KB ask, the KB not granted', { plane: 'live', asks: [accountAsk] }, NO_KB],
    ['no KB ask, a money tool', { plane: 'live', asks: [{ tool: 'pay.refund' }] }, WIDE],
  ].map(([name, input, laws]) => run(`desk, ${name}`, input, laws, { port: ok([KB_ROW]) })),
];

export async function deps(c) {
  if (c.port === undefined) return {};
  const { createHttpSupportDeskPort } = await import(pathToFileURL(`${SVC}support-agent/desk-port.ts`).href);
  const fetchImpl = async () => {
    if (c.port.throws) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify(c.port.body), { status: c.port.status, headers: { 'content-type': 'application/json' } });
  };
  return {
    supportDesk: createHttpSupportDeskPort({
      supportUrl: 'http://support.test/',
      ...(c.port.identity === false ? {} : { identityUrl: 'http://identity.test/' }),
      internalSecret: 'placeholder-agents-record-factories-internal-secret',
      fetchImpl,
    }),
  };
}
