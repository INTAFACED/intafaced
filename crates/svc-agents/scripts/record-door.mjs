// Records, from the TypeScript svc-agents in this checkout, what the Rust crate's door is held to:
//
// - `src/door/calls.rs`: every call's path, query or mutation, who may call it (public, a service, or a scope with its
//   guards), the checks its own middleware runs before the input is read, the person checks its handler runs first
//   after it, and which slice owns it. Each is read from the call's middlewares themselves, run on probe callers.
// - `src/door/schemas.json`: every call's input schema, as the tree of zod 4 parts the kit's zod engine runs.
// - `src/errors_table.rs`: every `AgentErrorCode`, and whether `AGENT_ERROR_CODES` lists it.
// - `tests/fixtures/input-parity/`: zod's own verdict on a few thousand inputs, made from each schema.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-agents^..." build`):
//   TZ=UTC node --import tsx crates/svc-agents/scripts/record-door.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-agents/scripts/record-door.mjs --check  fails when a written file is stale
//
// It reads the TypeScript service and `services/svc-agents/wire-replay.golden/`; it never writes there. It stops being
// runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-agents/src/`;
const NAME = 'record-door';
if (!existsSync(SVC)) {
  console.error(
    `${NAME}: services/svc-agents no longer exists (the Rust crate replaced it); nothing to record from. The files it wrote are the reference now.`,
  );
  process.exit(2);
}
const CHECK = process.argv.includes('--check');

if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC (new Date(text) reads a time with no offset in the local zone)`);
  process.exit(2);
}
// The wire replay's process: the blank sanctions list, vitest's NODE_ENV and svc-agents' vitest env.
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';

const { createAgentsRouter } = await import(`${SVC}router.ts`);
const { NO_TIER_LAWS } = await import(`${SVC}tier-laws.ts`);
const { AGENT_ERROR_CODES } = await import(`${SVC}errors.ts`);
// The service's own packages, resolved from the service as its tests resolve them.
const fromService = createRequire(`${SVC}index.ts`);
const load = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const { createEdgeContext, encodePrincipal, signPrincipalHeader } = await load('@intafaced/contracts');
const { default: Fastify } = await load('fastify');
const { fastifyTRPCPlugin } = await load('@trpc/server/adapters/fastify');

/** The router as the wire replay builds it: every optional dependency left out, a runtime that holds nothing. */
const deps = () => ({
  runtime: {},
  gateway: { routingTable: { routes: [] } },
  meter: {},
  feeAssetId: 'fixture-asset',
  tierLaws: NO_TIER_LAWS,
  loadCoachGrounding: async () => {
    throw new Error('coach grounding is unset in the wire replay');
  },
});
const router = createAgentsRouter(deps());
const procedures = Object.fromEntries(Object.entries(router._def.procedures).filter(([, p]) => p._def.type !== 'subscription'));
const paths = Object.keys(procedures).sort((a, b) => a.localeCompare(b));

const GOLDEN_DIR = `${ROOT}services/svc-agents/wire-replay.golden/`;
const goldenParts = readdirSync(GOLDEN_DIR)
  .filter((n) => n.endsWith('.json'))
  .sort()
  .map((n) => JSON.parse(readFileSync(`${GOLDEN_DIR}${n}`, 'utf8')));
const golden = {
  callers: goldenParts.flatMap((p) => p.callers).sort((a, b) => a.path.localeCompare(b.path)),
  inputs: Object.assign({}, ...goldenParts.map((p) => p.inputs)),
};
if (JSON.stringify(golden.callers.map((c) => c.path)) !== JSON.stringify(paths)) throw new Error('the router and the recording disagree');

// ── Who owns each call ─────────────────────────────────────────────────────────────────────────────────────────────

/** The slices (one Rust module each, `PORT.md`'s `## Slices`), and the calls each owns: exact paths, then `prefix*`. */
const SLICES = {
  door: ['health'],
  gateway: ['routes.*'],
  runtime: ['agent.*', 'session.*', 'run.complete', 'run.get', 'run.list', 'run.trace', 'run.events', 'log.*'],
  metering: ['usage.*', 'spend.*', 'analytics.*'],
  background: ['run.background.*'],
  navigator: ['navigator.*'],
  factories: ['scanner.*', 'support.*', 'merchant.*', 'copyIntel.*'],
  advisors: ['coach.*', 'riskCompliance.*', 'growth.*', 'launch.*', 'portfolio.*', 'marketplace.*'],
  ops: ['ops.*', 'opsLog.*', 'opsAlerts.*', 'fleet.*'],
  team: ['team.*'],
  'own-builder': [
    'own.catalogue',
    'own.create',
    'own.save',
    'own.get',
    'own.list',
    'own.delete',
    'own.publish',
    'own.publication',
    'own.status',
    'own.assistant.*',
    'own.rules.*',
    'own.reviewer.*',
    'own.review.*',
    'own.evals.*',
    'own.dryRun',
    'own.testRun',
    'own.testRuns',
    'own.testApprove',
    'own.toolTest',
    'own.tool.*',
  ],
  'own-runs': [
    'own.run',
    'own.runs',
    'own.session.*',
    'own.schedules.*',
    'own.triggers.*',
    'own.backgroundRun',
    'own.backgroundRuns',
    'own.inbox',
    'own.approval.*',
    'own.approvals',
    'own.holds',
    'own.trade.*',
  ],
  'own-controls': [
    'own.limits.*',
    'own.usageLimits.*',
    'own.usage',
    'own.usageByDay',
    'own.analytics',
    'own.paymentMethod.*',
    'own.policy.*',
    'own.privacy.*',
    'own.memory.*',
    'own.consents.*',
  ],
  'own-sharing': ['own.access.*', 'own.coOwners.*', 'own.share.*', 'own.sharedWithMe', 'own.identity.*'],
};

function sliceOf(path) {
  const exact = Object.entries(SLICES).filter(([, list]) => list.includes(path));
  if (exact.length === 1) return exact[0][0];
  if (exact.length > 1) throw new Error(`${path} is named by two slices`);
  const matches = Object.entries(SLICES)
    .flatMap(([slice, list]) => list.filter((p) => p.endsWith('*') && path.startsWith(p.slice(0, -1))).map((p) => [p.length, slice]))
    .sort((a, b) => b[0] - a[0]);
  if (matches.length === 0 || (matches.length > 1 && matches[0][0] === matches[1][0])) {
    throw new Error(`${path} matches ${matches.length} slices`);
  }
  return matches[0][1];
}

// ── The door table ─────────────────────────────────────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const SUB = '44444444-4444-4444-8444-444444444444';
/** Every scope a probe caller may hold: enough that no check refuses for a scope it does not name. */
const ALL_SCOPES = ['agents:read', 'agents:execute', 'identity:write', 'admin:read', 'admin:write', 'pay:write'];
const SERVICES = readdirSync(`${ROOT}services`).filter((n) => n.startsWith('svc-'));

const principal = (over = {}) => ({
  sub: USER,
  userId: USER,
  sid: '22222222-2222-4222-8222-222222222222',
  scopes: ALL_SCOPES,
  tier: 'full',
  mfa: true,
  expiresAt: new Date('2099-01-01T00:00:00Z'),
  ...over,
});

/** One middleware run on a probe context: `null` when it passed on to `next`, else the error it threw. */
async function run(mw, ctx) {
  try {
    await mw({ ctx, next: async () => ({ ok: true, marker: 'probe' }), path: 'probe', type: 'query', getRawInput: async () => undefined });
    return null;
  } catch (err) {
    return err;
  }
}
const said = (err) => (err === null ? null : `${err.code} ${err.message}`);

const isAuth = (src) => src.includes("'Authentication required'") && src.includes('!ctx.principal');
const isScoped = (src) => src.includes('refuseActingService(ctx, guards)') && src.includes('requireScope(ctx.principal, scope)');
const isServiceFor = (src) => src.includes('requireServiceCaller(ctx.service)') && src.includes('callers.includes(ctx.service)');
const isSettle = (src) =>
  /^\(\{\s*ctx,\s*next\s*\}\)\s*=>\s*\{\s*requireSettleService\(ctx\.service\);?\s*return next\(\{\s*ctx\s*\}\);?\s*\}$/.test(src);
const isPersonOnly = (src) =>
  /^\(\{\s*ctx,\s*next\s*\}\)\s*=>\s*\{\s*if\s*\(ctx\.principal\.kid\s*\|\|\s*ctx\.principal\.sub_account\)\s*\{?\s*throw new TRPCError\(\{\s*code:\s*"FORBIDDEN",\s*message:\s*"[a-z_.]+"\s*\}\);?\s*\}?\s*return next\(\);?\s*\}$/.test(
    src,
  );
const COACH_RUN =
  /^\(\{\s*ctx,\s*next\s*\}\)\s*=>\s*\{\s*if\s*\(!hasScope\(ctx\.principal\.scopes,\s*"agents:execute"\)\)\s*\{\s*throw new TRPCError\(\{\s*code:\s*"FORBIDDEN",\s*message:\s*"agents\.execute_scope_unset"\s*\}\);?\s*\}\s*try\s*\{\s*requireScope\(ctx\.principal,\s*"agents:execute"\);?\s*\}\s*catch\s*\(err\)\s*\{\s*if\s*\(err instanceof AuthError\)\s*throw new TRPCError\(\{\s*code:\s*"FORBIDDEN",\s*message:\s*err\.message,\s*cause:\s*err\s*\}\);?\s*throw err;?\s*\}\s*if\s*\(ctx\.principal\.kid\s*\|\|\s*ctx\.principal\.sub_account\)\s*\{\s*throw new TRPCError\(\{\s*code:\s*"FORBIDDEN",\s*message:\s*"agents\.execute_person_only"\s*\}\);?\s*\}\s*return next\(\);?\s*\}$/;
const flat = (fn) => fn.toString().replace(/\s+/g, ' ').trim();

/** The scoped middleware's guards, read by running it: its scope, whether a service is refused, and the region check. */
async function scopedGuards(path, mw) {
  const ctx = (over) => ({ principal: principal(), region: 'DE', service: null, ...over });
  const missing = said(await run(mw, ctx({ principal: principal({ scopes: [] }) })));
  const scope = /^FORBIDDEN Scope "([a-z:]+)" is required$/.exec(missing ?? '')?.[1];
  if (!scope) throw new Error(`${path}: the scoped middleware named no scope (${missing})`);
  const only = (over) => ctx({ principal: principal({ scopes: [scope], ...over }) });
  const own = said(await run(mw, only({})));
  if (own) throw new Error(`${path}: the scoped middleware refused its own scope: ${own}`);
  if (said(await run(mw, only({ tier: 'none', mfa: false }))) && !['admin:write'].includes(scope)) {
    throw new Error(`${path}: a tier or two-factor guard the door does not hold`);
  }
  const service = said(await run(mw, { ...only({}), service: 'svc-trade' }));
  const person = service === 'FORBIDDEN A signed-in user session is required';
  if (service !== null && !person) throw new Error(`${path}: a service refused as ${service}`);
  const region = said(await run(mw, { ...only({}), region: 'US' }));
  const module = region !== null;
  if (module && !region.startsWith('FORBIDDEN ')) throw new Error(`${path}: the region refused as ${region}`);
  return { scope, person, module };
}

/** The checks a call runs before its input, from its middlewares in order. */
async function chainOf(path, proc) {
  const mws = proc._def.middlewares.filter(
    (m) => m.name !== 'outputValidatorMiddleware' && m.name !== 'resolveMiddleware' && m.name !== 'errorFormatterMiddleware',
  );
  const out = { access: { t: 'public' }, pre: null, inputAt: null };
  const rest = [...mws];
  if (rest[0] && isAuth(flat(rest[0]))) {
    rest.shift();
    if (!rest[0] || !isScoped(flat(rest[0]))) throw new Error(`${path}: signed in, but not through scopedProcedure`);
    out.access = { t: 'scope', ...(await scopedGuards(path, rest.shift())) };
  } else if (rest[0] && isServiceFor(flat(rest[0]))) {
    const mw = rest.shift();
    const callers = [];
    for (const s of SERVICES) if ((await run(mw, { principal: null, region: 'DE', service: s })) === null) callers.push(s);
    out.access = { t: 'service', callers };
  } else if (rest[0] && isSettle(flat(rest[0]))) {
    rest.shift();
    out.access = { t: 'settle' };
  }
  if (rest[0] && rest[0]._type !== 'input') {
    const mw = rest.shift();
    const src = flat(mw);
    if (COACH_RUN.test(src)) out.pre = { t: 'coach_run' };
    else if (isPersonOnly(src)) {
      const refused = said(await run(mw, { principal: principal({ kid: 'key-1' }), region: 'DE', service: null }));
      const sub = said(await run(mw, { principal: principal({ sub_account: SUB }), region: 'DE', service: null }));
      if (refused !== sub || !refused?.startsWith('FORBIDDEN ')) throw new Error(`${path}: a person check that says ${refused} / ${sub}`);
      if (said(await run(mw, { principal: principal(), region: 'DE', service: null }))) throw new Error(`${path}: it refuses the person`);
      out.pre = { t: 'person_only', message: refused.slice('FORBIDDEN '.length) };
    } else throw new Error(`${path}: a middleware the door does not know: ${src.slice(0, 200)}`);
  }
  if (rest[0] && rest[0]._type === 'input') rest.shift();
  if (rest.length) throw new Error(`${path}: ${rest.length} middlewares after its input`);
  return out;
}

// The handlers' first checks, read by sending each call a valid input from callers that differ in one thing.
/** The probe app's edge secret: a placeholder that signs only the recorder's own requests. */
const SECRET = 'placeholder-agents-record-door-edge-secret';
const app = Fastify();
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: createAgentsRouter(deps()),
    createContext: ({ req }) => createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' })(req),
  },
});
async function hit(path, kind, input, p) {
  const raw = encodePrincipal(p);
  const h = {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
  const url = `/trpc/${path}${kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  const res =
    kind === 'query'
      ? await app.inject({ method: 'GET', url, headers: h })
      : await app.inject({
          method: 'POST',
          url,
          headers: { ...h, 'content-type': 'application/json' },
          payload: input === undefined ? '' : JSON.stringify(input),
        });
  const body = JSON.parse(res.body);
  return { status: res.statusCode, message: body.error?.message ?? null };
}

/** A caller that differs from the person in one thing, and what the handler's first check would say to it. */
const VARIANTS = {
  key: { kid: 'key-1' },
  sub_account: { sub_account: SUB },
  lacks_identity_write: { scopes: ALL_SCOPES.filter((s) => s !== 'identity:write') },
};
const SESSION_REQUIRED = 'A signed-in user session is required';

async function postOf(path, proc, chain, valid) {
  const none = { key: false, sub_account: false, lacks_identity_write: false };
  if (chain.access.t !== 'scope' || valid === undefined) return none;
  const kind = proc._def.type;
  const person = await hit(path, kind, valid, principal());
  // The sample did not pass the schema: nothing past the input is reached.
  const isIssues = (a) => a.status === 400 && (a.message ?? '').startsWith('[');
  if (isIssues(person)) return none;
  const hasInput = proc._def.inputs.length > 0;
  const post = { ...none };
  for (const [name, over] of Object.entries(VARIANTS)) {
    const a = await hit(path, kind, valid, principal(over));
    // Refused only once the input passed (a call with no input has nothing to pass): the handler's own first check.
    const after = !hasInput || isIssues(await hit(path, kind, 7, principal(over)));
    if (a.status === 403 && a.message === SESSION_REQUIRED && person.message !== SESSION_REQUIRED && after) post[name] = true;
    else if (hasInput && a.status === 403 && a.message !== person.message && after && a.message !== SESSION_REQUIRED) {
      // A refusal of its own words belongs to the slice; noted so a later slice finds it.
      post.other = [...(post.other ?? []), `${name}: ${a.message}`];
    }
  }
  return post;
}

// ── The input schemas ──────────────────────────────────────────────────────────────────────────────────────────────

/** Each refine's function source, named: the Rust crate implements each by its name (`src/door/refines.rs`). */
const REFINES = {
  'args=>Object.keys(args).length<=8': 'at_most_eight_keys',
  '(args) => Object.keys(args).length <= 8': 'at_most_eight_keys',
};
/** `superRefine`s, by the schema that carries them (their check's source is zod's own wrapper). */
const SUPER_REFINES = new Map([]);

/** The one transform the doors use: `(s) => s.trim()` on a string, as tsx prints it. */
const TRIM_TRANSFORMS = new Set(['(s) => s.trim()', 's=>s.trim()']);

/**
 * A pipe. `z.string().transform((s) => s.trim())` is recorded as the string with `trim` as its one check: the same
 * parse, since the transform only ever sees a string that passed. Any other pipe is recorded as one: the first part,
 * then the second on what passed it. Any other transform is refused, never guessed.
 */
function pipe(s, checks) {
  const d = s._zod.def;
  if (checks.length) throw new Error('a pipe with its own checks');
  const out = d.out._zod.def;
  if (out.type !== 'transform') return { t: 'pipe', in: node(d.in), out: node(d.out) };
  const from = d.in._zod.def;
  if (from.type !== 'string' || from.checks?.length || from.coerce || !TRIM_TRANSFORMS.has(out.transform.toString())) {
    throw new Error(`a transform other than a string's trim: ${out.transform.toString()}`);
  }
  return { t: 'string', checks: [{ k: 'trim' }] };
}

const ids = new Map();
const nodes = [];
/** Refines found with no name: the recorder lists them all, then stops. */
const UNNAMED = new Set();

function messageOf(def) {
  if (!def.error) return undefined;
  const m = def.error({});
  return typeof m === 'string' ? m : m?.message;
}

const LENGTH_WHEN = 'val.length !== undefined';

function check(c, owner) {
  const d = c._zod.def;
  const out = (k, extra = {}) => {
    const msg = messageOf(d);
    return { k, ...extra, ...(d.abort ? { abort: true } : {}), ...(msg !== undefined ? { msg } : {}) };
  };
  if (d.when && !(['min_length', 'max_length'].includes(d.check) && d.when.toString().includes(LENGTH_WHEN))) {
    throw new Error(`a check with its own when: ${d.check}`);
  }
  switch (d.check) {
    case 'min_length':
      return out('min_length', { n: d.minimum });
    case 'max_length':
      return out('max_length', { n: d.maximum });
    case 'string_format':
      if (d.format === 'regex') return out('regex', { src: d.pattern.toString() });
      if (d.format === 'starts_with') return out('starts_with', { prefix: d.prefix });
      if (d.format === 'url') {
        for (const k of ['normalize', 'hostname', 'protocol']) if (k in d) throw new Error(`url with ${k}`);
        return out('url');
      }
      if (['guid', 'uuid', 'datetime'].includes(d.format)) return out('format', { format: d.format, src: d.pattern.toString() });
      throw new Error(`string format ${d.format}`);
    case 'overwrite': {
      const src = d.tx.toString();
      if (src === '(input) => input.trim()') return out('trim');
      if (src === '(input) => input.toLowerCase()') return out('lower');
      throw new Error(`overwrite ${src}`);
    }
    case 'greater_than':
      return out('gt', { v: d.value, incl: d.inclusive });
    case 'less_than':
      return out('lt', { v: d.value, incl: d.inclusive });
    case 'number_format':
      if (d.format !== 'safeint') throw new Error(`number format ${d.format}`);
      return out('int');
    case 'custom': {
      if (d.fn === undefined) {
        const id = SUPER_REFINES.get(owner);
        if (!id) throw new Error('an unnamed superRefine');
        return { k: 'super', id };
      }
      const name = REFINES[d.fn.toString()];
      if (!name) UNNAMED.add(d.fn.toString());
      return out('refine', { id: name, ...(d.path ? { path: d.path } : {}) });
    }
    default:
      throw new Error(`check ${d.check}`);
  }
}

function node(s) {
  if (ids.has(s)) return ids.get(s);
  const id = nodes.length;
  ids.set(s, id);
  nodes.push(null);
  nodes[id] = build(s);
  return id;
}

function build(s) {
  const d = s._zod.def;
  if (d.error) throw new Error(`a ${d.type} schema with its own error`);
  const self = s._zod.traits.has('$ZodCheck') && d.type === 'string' ? [s] : [];
  const checks = [...self, ...(d.checks ?? [])].map((c) => check(c, s));
  const withChecks = (o) => (checks.length ? { ...o, checks } : o);
  switch (d.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'date':
      return withChecks({ t: d.type, ...(d.coerce ? { coerce: true } : {}) });
    case 'unknown':
      return withChecks({ t: 'unknown' });
    case 'enum':
      return withChecks({ t: 'enum', values: s.options });
    case 'literal':
      return withChecks({ t: 'literal', values: d.values });
    case 'object': {
      const shape = Object.entries(d.shape).map(([k, v]) => [k, node(v)]);
      let catchall = null;
      if (d.catchall) {
        const t = d.catchall._zod.def.type;
        if (t === 'never') catchall = 'strict';
        else if (t === 'unknown') catchall = 'passthrough';
        else throw new Error(`catchall ${t}`);
      }
      return withChecks({ t: 'object', shape, ...(catchall ? { catchall } : {}) });
    }
    case 'array':
      return withChecks({ t: 'array', el: node(d.element) });
    case 'optional':
    case 'nullable':
      return withChecks({ t: d.type, in: node(d.innerType) });
    case 'default':
      return withChecks({ t: 'default', in: node(d.innerType), value: d.defaultValue });
    case 'union':
      if (d.discriminator !== undefined) {
        if (d.unionFallback) throw new Error('a discriminated union with a fallback');
        return withChecks({ t: 'dunion', disc: d.discriminator, options: d.options.map(node) });
      }
      if (d.inclusive === false) throw new Error('an exclusive union');
      return withChecks({ t: 'union', options: d.options.map(node) });
    case 'record':
      if (d.mode && d.mode !== 'strict') throw new Error(`record mode ${d.mode}`);
      return withChecks({ t: 'record', key: node(d.keyType), value: node(d.valueType) });
    case 'lazy':
      return withChecks({ t: 'lazy', in: node(s._zod.innerType) });
    case 'pipe':
      return pipe(s, checks);
    default:
      throw new Error(`schema type ${d.type}`);
  }
}

const inputs = {};
for (const path of paths) {
  const ins = procedures[path]._def.inputs;
  if (ins.length > 1) throw new Error(`${path} has ${ins.length} inputs`);
  if (ins.length === 1) inputs[path] = node(ins[0]);
}

if (UNNAMED.size) throw new Error(`unnamed refines:\n${[...UNNAMED].join('\n---\n')}`);

// ── zod's verdicts ─────────────────────────────────────────────────────────────────────────────────────────────────

const byNode = [...ids.entries()].reduce((m, [s, id]) => m.set(id, s), new Map());

/** `ok <output>`, `issues <zod's issues>`, or `throws <message>` when a refine itself throws (tRPC answers 400 with it). */
function verdict(schema, input, text) {
  let r;
  try {
    r = schema.safeParse(input);
  } catch (err) {
    return `throws ${err.message}`;
  }
  if (!r.success) return `issues ${JSON.stringify(r.error.issues)}`;
  const out = JSON.stringify(r.data) ?? 'undefined';
  // `ok =`: the output is the input as sent.
  return out === text ? 'ok =' : `ok ${out}`;
}

/** Strings tried for each string part: what one accepts is a valid sample of it, the rest probe its checks. */
const POOL = [
  '',
  ' ',
  'a',
  'abc',
  'placeholder',
  'Placeholder Title',
  '  padded  ',
  '﻿bom﻿',
  '\u0085next\u0085',
  'a-b',
  'a_b',
  'A',
  'ABC',
  'ab-CD',
  'en',
  'en-GB',
  'de-AT',
  'zh-Hant',
  '0',
  '1',
  '7',
  '10',
  '0.5',
  '0.25',
  '1.0',
  '1.00',
  '1.5',
  '12.34',
  '1.234',
  '0.0001',
  '-1',
  '-0.5',
  '100',
  '999999',
  '1000000',
  '0x' + 'a'.repeat(40),
  '0x' + 'A1'.repeat(20),
  '0x' + 'b'.repeat(64),
  'f'.repeat(32),
  'e'.repeat(64),
  'custom:33333333-3333-4333-8333-333333333333',
  '33333333-3333-4333-8333-333333333333',
  '33333333-3333-4333-8333-33333333333',
  'not-a-uuid',
  'my-course',
  'my--course',
  '-lead',
  'snake_case',
  'video/mp4',
  'application/pdf',
  'c++',
  '#tag',
  '10.0.0.1',
  '192.168.0.0/24',
  '::1',
  '2001:db8::/32',
  '1.2.3',
  'https://example.com/a',
  ' https://example.com/a ',
  'http://example.com/a',
  'https:example.com',
  'ftp://example.com',
  'https://exa\nmple.com',
  'example.com',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00+08:00',
  '2026-01-01T00:00:00',
  '2026-02-30T00:00:00Z',
  '2026-01-01',
  'Jan 5 2026',
  '2026/01/05',
  '😀',
  '😀😀😀',
  'x'.repeat(41),
];

/** How a long probe is written in the parity file: `["repeat", before, unit, count, after]`, read back the same way. */
const LONG = new Map();
function long(before, unit, count, after = '') {
  const s = before + unit.repeat(count) + after;
  if (s.length > 64) LONG.set(s, ['repeat', before, unit, count, after]);
  return s;
}
/** `["many", element as JSON text, count]`: an array of one element repeated. */
const MANY = new WeakMap();
function many(el, count) {
  const arr = Array.from({ length: count }, () => el);
  if (count > 4) MANY.set(arr, ['many', JSON.stringify(el), count]);
  return arr;
}
function encodeProbe(v) {
  if (v === undefined) return null;
  if (typeof v === 'string' && LONG.has(v)) return LONG.get(v);
  if (Array.isArray(v) && MANY.has(v)) return MANY.get(v);
  return JSON.stringify(v);
}

function poolFor(s) {
  const d = s._zod.def;
  const extra = [];
  for (const c of d.checks ?? []) {
    const cd = c._zod.def;
    if (cd.check === 'max_length')
      extra.push(long('', 'a', cd.maximum), long('', 'a', cd.maximum + 1), long('', '😀', cd.maximum), long(' ', 'a', cd.maximum, ' '));
    if (cd.check === 'min_length' && cd.minimum > 1)
      extra.push(long('', 'a', cd.minimum), long('', 'a', cd.minimum - 1), long('', '😀', cd.minimum - 1));
    if (cd.check === 'string_format' && cd.format === 'starts_with') extra.push(`${cd.prefix}example.com/a`);
  }
  return [...POOL, ...extra];
}

const NUMBERS = [0, 1, 2, 7, -1, 0.5, 1.5, -0.5, 59, 60, 100, 101, 1000, 3600, 86400, 1e6, 2 ** 31, 2 ** 53, -(2 ** 53), 1e21, 1e-7];
const DATES = [
  '2026-01-01T00:00:00.000Z',
  '2026-01-01',
  '2026-01-01T10:00',
  '2026-01-01 10:00:00',
  '2026-13-01',
  'Jan 5 2026 10:00 GMT+0100',
  '5 January 2026',
  'Mon, 05 Jan 2026 10:00:00 GMT',
  '2026/01/05',
  '1/5/2026',
  'tomorrow',
  '',
  '+002026-01-01T00:00:00Z',
  '2026-01-01T00:00:00.123456Z',
  '20260101',
  0,
  7,
  -1,
  8.64e15,
  8.64e15 + 1,
  1.5,
  true,
  null,
  [],
  [2026],
  {},
];

/** A value the part accepts, when one is found; `undefined` otherwise. */
function sample(id, depth = 0) {
  const s = byNode.get(id);
  const n = nodes[id];
  const ok = (v) => s.safeParse(v).success;
  if (depth > 6) return undefined;
  switch (n.t) {
    case 'string':
      return poolFor(s).find(ok);
    case 'number':
      return NUMBERS.find(ok);
    case 'boolean':
      return true;
    case 'date':
      return n.coerce ? '2026-01-01T00:00:00.000Z' : undefined;
    case 'unknown':
      return 'anything';
    case 'enum':
    case 'literal':
      return n.values[0];
    case 'optional':
      return sample(n.in, depth + 1);
    case 'nullable': {
      const v = sample(n.in, depth + 1);
      return v === undefined ? null : v;
    }
    case 'default':
      return sample(n.in, depth + 1);
    case 'lazy':
      return depth > 3 ? undefined : sample(n.in, depth + 1);
    case 'object': {
      const out = {};
      for (const [k, v] of n.shape) {
        const inner = nodes[v];
        if (inner.t === 'optional' && depth > 0) continue;
        const sv = sample(v, depth + 1);
        if (sv !== undefined) out[k] = sv;
      }
      if (ok(out)) return out;
      // Try the refines' usual escape: every nullable field null, every optional left out.
      const lean = {};
      for (const [k, v] of n.shape) {
        const inner = nodes[v];
        if (inner.t === 'optional') continue;
        lean[k] = inner.t === 'nullable' ? null : out[k];
      }
      return ok(lean) ? lean : out;
    }
    case 'array': {
      const min = (n.checks ?? []).find((c) => c.k === 'min_length')?.n ?? 0;
      const el = sample(n.el, depth + 1);
      if (el === undefined) return [];
      const arr = Array.from({ length: Math.max(min, 1) }, () => structuredClone(el));
      if (ok(arr)) return arr;
      // Unique ids: number each element's string fields.
      const numbered = arr.map((e, i) => (typeof e === 'object' && e && !Array.isArray(e) ? { ...e, id: `${e.id ?? 'id'}-${i}` } : e));
      return ok(numbered) ? numbered : arr;
    }
    case 'union':
    case 'dunion':
      for (const o of n.options) {
        const v = sample(o, depth + 1);
        if (v !== undefined && ok(v)) return v;
      }
      return sample(n.options[0], depth + 1);
    case 'record':
      return {};
    default:
      return undefined;
  }
}

/** Values to put at one place in a sample, chosen from the part found there. */
function probes(id) {
  const s = byNode.get(id);
  const n = nodes[id];
  const base = [undefined, null, 7, 'x', true, [], {}];
  switch (n.t) {
    case 'string':
      return [...base, ...poolFor(s).filter((v, i, a) => a.indexOf(v) === i)];
    case 'number':
      return [...base, ...NUMBERS, '5'];
    case 'date':
      return [...base, ...DATES];
    case 'enum':
    case 'literal':
      return [...base, ...n.values, 'nope', String(n.values[0]).toUpperCase()];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'lazy':
      return [...probes(n.in)];
    case 'array': {
      const el = sample(n.el);
      const max = (n.checks ?? []).find((c) => c.k === 'max_length')?.n;
      const out = [...base, [el], [el, el], [7], [null]];
      if (max !== undefined && max < 2000) out.push(many(el, max + 1), many(el, max));
      return out;
    }
    default:
      return base;
  }
}

/** Every place in a value's tree, with the part that checks it: [path, nodeId]. */
function places(id, value, path = [], depth = 0, out = []) {
  if (depth > 4) return out;
  let n = nodes[id];
  while (['optional', 'nullable', 'default', 'lazy'].includes(n.t)) {
    id = n.in;
    n = nodes[id];
  }
  if (n.t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of n.shape) {
      out.push([[...path, k], v]);
      places(v, value[k], [...path, k], depth + 1, out);
    }
  } else if (n.t === 'array' && Array.isArray(value) && value.length > 0) {
    out.push([[...path, 0], n.el]);
    places(n.el, value[0], [...path, 0], depth + 1, out);
  } else if (n.t === 'dunion' || n.t === 'union') {
    for (const o of n.options) if (sample(o) !== undefined && byNode.get(o).safeParse(value).success) places(o, value, path, depth, out);
  }
  return out;
}

function setAt(value, path, v) {
  const copy = structuredClone(value);
  let at = copy;
  for (const k of path.slice(0, -1)) {
    if (at === null || typeof at !== 'object') return undefined;
    at = at[k];
  }
  if (at === null || typeof at !== 'object') return undefined;
  const last = path.at(-1);
  if (v === undefined) delete at[last];
  else at[last] = v;
  return copy;
}

/** A cheap deterministic shuffle, so a schema's many probes are thinned the same way on every run. */
function pick(list, max, seed) {
  if (list.length <= max) return list;
  const scored = list.map((v, i) => [createHash('sha256').update(`${seed}:${i}`).digest().readUInt32BE(0), v]);
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, max)
    .map(([, v]) => v);
}

/**
 * Each case is `[path, input, verdict]`; an input is null (none), JSON text, or `[base, at, value]`: base `bases[base]`
 * with the value at path `at` replaced by `value`, or removed when `value` is null. `value` is JSON text, or a long one
 * written short: `["repeat", before, unit, count, after]` (a string) or `["many", element JSON text, count]` (an array).
 */
const cases = [];
const bases = [];
const seenRoots = new Map();
for (const path of paths) {
  const id = inputs[path];
  if (id === undefined) {
    cases.push([path, null, verdict({ safeParse: () => ({ success: true, data: undefined }) }, undefined, null)]);
    continue;
  }
  // Calls sharing one schema share its cases: the first one carries them, the rest one each.
  const schema = byNode.get(id);
  const texts = new Set();
  const add = (v, encoded) => {
    const text = v === undefined ? null : JSON.stringify(v);
    if (texts.has(text)) return;
    texts.add(text);
    cases.push([path, encoded ?? text, verdict(schema, v === undefined ? undefined : JSON.parse(text), text)]);
  };
  const valid = golden.inputs[path] ?? undefined;
  const mine = sample(id);
  if (seenRoots.has(id)) {
    add(mine);
    continue;
  }
  seenRoots.set(id, path);
  for (const v of [undefined, null, 7, 'x', [], {}, valid, mine]) add(v);
  const obj = mine && typeof mine === 'object' && !Array.isArray(mine) ? mine : {};
  add({ ...obj, extra: 1 });
  add({ b: 1, 2: 2, ...obj, a: 3, 1: 4 });
  if (mine === undefined) continue;
  const base = bases.push(JSON.stringify(mine)) - 1;
  const mutations = [];
  for (const [p, at] of places(id, mine)) for (const v of probes(at)) mutations.push([p, v, setAt(mine, p, v)]);
  for (const [p, v, m] of pick(
    mutations.filter((m) => m[2] !== undefined),
    32,
    path,
  ))
    add(m, [base, p, encodeProbe(v)]);
  // Two faults at once, so the order issues come in is held too.
  const ps = places(id, mine);
  if (ps.length >= 2) {
    const [[p1], [p2]] = [ps[0], ps.at(-1)];
    const both = setAt(setAt(mine, p1, 7) ?? mine, p2, null);
    if (both !== undefined) add(both);
  }
}

// ── The door table, from the chains and a valid input each ────────────────────────────────────────────────────────

const table = [];
const otherFirstChecks = [];
for (const c of golden.callers) {
  const proc = procedures[c.path];
  const chain = await chainOf(c.path, proc);
  const recorded = { public: 'public', service: 'service', settle: 'public', scope: 'scope' }[chain.access.t];
  if (recorded !== c.caller) throw new Error(`${c.path}: the recording names its caller ${c.caller}, the chain ${chain.access.t}`);
  const id = inputs[c.path];
  const candidates = [golden.inputs[c.path] ?? undefined, id === undefined ? undefined : sample(id)];
  const valid = id === undefined ? undefined : candidates.find((v) => v !== undefined && byNode.get(id).safeParse(v).success);
  const post = await postOf(c.path, proc, chain, id === undefined ? null : valid);
  if (post.other) otherFirstChecks.push(`${c.path}: ${post.other.join('; ')}`);
  table.push({ path: c.path, kind: c.type, ...chain, post, slice: sliceOf(c.path), hasInput: id !== undefined });
}
await app.close();

// ── The error catalogue ────────────────────────────────────────────────────────────────────────────────────────────

const errorsSource = readFileSync(`${SVC}errors.ts`, 'utf8');
const union = /export type AgentErrorCode =([\s\S]*?);\n/.exec(errorsSource)?.[1];
if (!union) throw new Error('errors.ts: no AgentErrorCode union');
const errorCodes = [...union.matchAll(/\|\s*'([a-z_.]+)'/g)].map((m) => m[1]);
for (const code of AGENT_ERROR_CODES)
  if (!errorCodes.includes(code)) throw new Error(`AGENT_ERROR_CODES lists ${code}, the union does not`);

// ── The environment ────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_BASE = {
  EDGE_PRINCIPAL_SECRET: 'placeholder-agents-env-parity-edge-secret',
  INTERNAL_SERVICE_SECRET: 'placeholder-agents-env-parity-internal-secret',
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://agents:agents@localhost:5432/agents_test',
  DATABASE_POOL_MAX: '4',
  LEDGER_URL: 'http://localhost:4001',
  AGENTS_FEE_ASSET_ID: 'IFC',
  AGENTS_USAGE_WINDOW_MINUTES: '60',
  AGENTS_METERING_ENABLED: 'true',
};
const ENV_CASES = [
  {},
  { LEDGER_URL: undefined, AGENTS_FEE_ASSET_ID: undefined, AGENTS_USAGE_WINDOW_MINUTES: undefined, AGENTS_METERING_ENABLED: undefined },
  { LEDGER_URL: '', AGENTS_FEE_ASSET_ID: '   ', AGENTS_USAGE_WINDOW_MINUTES: '', AGENTS_METERING_ENABLED: '  ' },
  { LEDGER_URL: 'not a url', AGENTS_FEE_ASSET_ID: '  IFC  ' },
  { AGENTS_USAGE_WINDOW_MINUTES: '7' },
  { AGENTS_USAGE_WINDOW_MINUTES: '0' },
  { AGENTS_USAGE_WINDOW_MINUTES: '1441' },
  { AGENTS_USAGE_WINDOW_MINUTES: '1.5' },
  { AGENTS_USAGE_WINDOW_MINUTES: 'hourly' },
  { AGENTS_USAGE_WINDOW_MINUTES: '1440' },
  { AGENTS_METERING_ENABLED: ' OFF ' },
  { AGENTS_METERING_ENABLED: 'yes' },
  { AGENTS_METERING_ENABLED: '0' },
  { AGENTS_METERING_ENABLED: 'garbage' },
  { AGENTS_METERING_ENABLED: 'false ' },
  {
    IDENTITY_URL: 'http://localhost:4002',
    ACADEMY_URL: ' ',
    SUPPORT_URL: '',
    TRADE_URL: 'http://localhost:4004',
    PAY_URL: 'http://localhost:4007',
    BANK_URL: 'http://localhost:4005',
  },
  { IDENTITY_URL: 'identity', TRADE_URL: 'ftp:/x', BANK_URL: 'nope' },
  { PORTFOLIO_QUOTE_ASSET: ' USDC ', LIVE_TRADE_COPY_LEADER_PLANE_OPEN: 'true', LIVE_TRADE_COPY_LEADER_IDS: 'a,b' },
  { PORTFOLIO_QUOTE_ASSET: 'x'.repeat(33), LIVE_TRADE_COPY_LEADER_PLANE_OPEN: 'yes', LIVE_TRADE_COPY_LEADER_IDS: '' },
  { AGENTS_OVERAGE_GRACE: ' 0.5 ', AGENTS_PROVIDER: 'upstream', AGENTS_MOCK_DELAY_MS: '250' },
  { AGENTS_OVERAGE_GRACE: '1e3', AGENTS_PROVIDER: 'vendor', AGENTS_MOCK_DELAY_MS: '10001' },
  { AGENTS_OVERAGE_GRACE: '', AGENTS_MOCK_DELAY_MS: '', AGENTS_MOCK_HOLD_FILE: '  ' },
  { AGENTS_MOCK_HOLD_FILE: ' /tmp/hold ', AGENTS_MOCK_DELAY_MS: '-1' },
  {
    AGENTS_UPSTREAM_BASE_URL: 'https://engine.example',
    AGENTS_UPSTREAM_API_KEY: 'placeholder-upstream-key',
    AGENTS_UPSTREAM_AUTH_HEADER: 'authorization',
    AGENTS_UPSTREAM_AUTH_PREFIX: 'Bearer ',
    AGENTS_UPSTREAM_HEADERS: '{"x-version":"1","b":"2"}',
    AGENTS_UPSTREAM_COMPLETIONS_PATH: '/v2/complete',
    AGENTS_UPSTREAM_EMBEDDINGS_PATH: '/v2/embed',
    AGENTS_UPSTREAM_MODELS: '{"fast":"model-a"}',
    AGENTS_UPSTREAM_TIMEOUT_MS: '5000',
  },
  { AGENTS_UPSTREAM_BASE_URL: '', AGENTS_UPSTREAM_API_KEY: '', AGENTS_UPSTREAM_TIMEOUT_MS: '999' },
  { AGENTS_UPSTREAM_HEADERS: '[]', AGENTS_UPSTREAM_MODELS: '{"a":1}' },
  { AGENTS_UPSTREAM_HEADERS: 'null', AGENTS_UPSTREAM_MODELS: '"text"', AGENTS_UPSTREAM_TIMEOUT_MS: '600001' },
  { AGENTS_UPSTREAM_HEADERS: '', AGENTS_UPSTREAM_MODELS: '{}' },
  { AGENTS_ROUTING_TABLE: '{"routes":[]}', AGENTS_TIER_LAWS: '', AGENTS_OWN_TEMPLATES: ' ', AGENTS_POLICY_BASELINE: '{}' },
  { AGENTS_OWN_TOKEN_LIFETIME_MINUTES: '525600', AGENTS_OWN_ASSISTANT_MODEL: 'test-engine', AGENTS_REVIEWER_MODEL: 'x'.repeat(201) },
  { AGENTS_OWN_TOKEN_LIFETIME_MINUTES: '0', AGENTS_APPROVAL_TTL_SECONDS: '604801', AGENTS_OWN_ASSISTANT_MODEL: '' },
  {
    AGENTS_RETENTION_ACTION_LOG_DAYS: '30',
    AGENTS_RETENTION_MEMORY_DAYS: '36501',
    AGENTS_RETENTION_TRANSCRIPTS_DAYS: ' ',
    AGENTS_RETENTION_APPROVALS_DAYS: '1.5',
    AGENTS_RETENTION_USAGE_DAYS: 'week',
  },
  { AGENTS_NAVIGATOR_ONCHAIN_SIGNER: ` 0x${'a'.repeat(40)} `, AGENTS_NAVIGATOR_ONCHAIN_RPC_URL: 'http://rpc.example' },
  {
    AGENTS_NAVIGATOR_ONCHAIN_SIGNER: '0x12',
    AGENTS_NAVIGATOR_ONCHAIN_SENDER_URL: 'nope',
    AGENTS_NAVIGATOR_ONCHAIN_MARKET: 'x'.repeat(4001),
  },
  { AGENTS_LOG_READ_REASONS: 'audit,complaint', AGENTS_OPS_ACTIONS_LIMIT: '500', AGENTS_REGISTRY_LIST_LIMIT: '501' },
  { AGENTS_BACKGROUND_TEST_STEPS: '10000', AGENTS_BACKGROUND_STEP_MS: '199', AGENTS_SESSION_RUN_MAX_STEPS: '1001' },
  {
    AGENTS_SCHEDULE_MIN_INTERVAL_MINUTES: '15',
    AGENTS_SCHEDULE_DAILY_LIMIT: '10001',
    AGENTS_SCHEDULE_TICK_MS: '499',
    AGENTS_SCHEDULE_WORKERS: '8',
  },
  { AGENTS_RESEARCH_UNCERTAINTY_SCALE: ' low,high ', AGENTS_TRANSCRIPT_RETENTION_DAYS: '0' },
  { AGENTS_RESEARCH_UNCERTAINTY_SCALE: '   ', AGENTS_TRANSCRIPT_RETENTION_DAYS: '3651' },
  {
    AGENTS_PAYMENT_RPC_URL: 'http://chain.example',
    AGENTS_PAYMENT_CHAIN_ID: '8453',
    AGENTS_PAYMENT_TOKEN_ADDRESS: ` 0x${'B'.repeat(40)} `,
    AGENTS_PAYMENT_TOKEN_DECIMALS: '6',
  },
  { AGENTS_PAYMENT_CHAIN_ID: '0', AGENTS_PAYMENT_TOKEN_ADDRESS: 'nope', AGENTS_PAYMENT_TOKEN_DECIMALS: '37' },
  { HTTP_PORT: '4100', SERVICE_NAME: 'svc-agents-2', LOG_LEVEL: 'loud' },
  { HTTP_PORT: '1.5', NODE_ENV: 'staging' },
  { EDGE_PRINCIPAL_SECRET: 'placeholder', INTERNAL_SERVICE_SECRET: undefined },
  { DATABASE_URL: undefined, DATABASE_POOL_MAX: '201', DATABASE_SSL: 'YES', NATS_URL: '  ' },
  { S2S_AUTH_MODE: 'dual', S2S_SIGNING_KID: 'ab', INTERNAL_SERVICE_BODY_BIND: 'require' },
  { NODE_ENV: 'production', APP_ENV: 'prod' },
];

const envProbe = `${CRATE}scripts/env-probe.mjs`;
const envCases = ENV_CASES.map((overrides) => {
  const vars = { ...ENV_BASE, ...overrides };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', envProbe], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TZ: 'UTC', AGENTS_ENV_PROBE: JSON.stringify(vars) },
    encoding: 'utf8',
  });
  return { env: vars, answer: JSON.parse(out) };
});

/**
 * The parity fixture, in files the CI review can read: the distinct verdicts and base inputs once
 * (`input-parity/verdicts.golden.json`), and each slice's cases (`input-parity/<slice>.golden.json`), each case naming
 * its verdict by index.
 */
function parityFiles() {
  const verdicts = [];
  const at = new Map();
  const bySlice = Object.fromEntries(Object.keys(SLICES).map((s) => [s, []]));
  for (const [path, input, v] of cases) {
    if (!at.has(v)) at.set(v, verdicts.push(v) - 1);
    bySlice[sliceOf(path)].push(JSON.stringify([path, input, at.get(v)]));
  }
  const dir = `${CRATE}tests/fixtures/input-parity/`;
  return [
    [`${dir}verdicts.golden.json`, JSON.stringify({ verdicts, bases })],
    ...Object.entries(bySlice).map(([slice, rows]) => [`${dir}${slice}.golden.json`, `{"cases":[${rows.join(',')}]}`]),
  ];
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = '// @generated by crates/svc-agents/scripts/record-door.mjs from the TypeScript svc-agents. Do not edit by hand.\n';
const rustStr = (s) => JSON.stringify(s);
const sliceType = (s) =>
  s
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

function accessRs(a) {
  switch (a.t) {
    case 'public':
      return 'Access::Public';
    case 'settle':
      return 'Access::Settle';
    case 'service':
      return `Access::Service(&[${a.callers.map(rustStr).join(', ')}])`;
    case 'scope':
      return `Access::Scope(Scoped { scope: ${rustStr(a.scope)}, person: ${a.person}, module: ${a.module} })`;
    default:
      throw new Error(`access ${a.t}`);
  }
}
function preRs(p) {
  if (p === null) return 'Pre::None';
  if (p.t === 'coach_run') return 'Pre::CoachRun';
  return `Pre::PersonOnly(${rustStr(p.message)})`;
}

const callsRs = `${HEADER}//! Every call the door serves, sorted by path as \`procedureCallers\` sorts it.

use super::{Access, Call, Kind, Post, Pre, Scoped, Slice};

/// The ${table.length} calls.
pub const CALLS: [Call; ${table.length}] = [
${table
  .map(
    (c) => `    Call {
        path: ${rustStr(c.path)},
        kind: Kind::${c.kind === 'query' ? 'Query' : 'Mutation'},
        access: ${accessRs(c.access)},
        pre: ${preRs(c.pre)},
        post: Post { key: ${c.post.key}, sub_account: ${c.post.sub_account}, lacks_identity_write: ${c.post.lacks_identity_write} },
        slice: Slice::${sliceType(c.slice)},
        has_input: ${c.hasInput},
    },`,
  )
  .join('\n')}
];
`;

const errorsRs = `${HEADER}//! Every \`AgentErrorCode\` (\`services/svc-agents/src/errors.ts\`, in the union's order), and whether the catalogue
//! \`AGENT_ERROR_CODES\` lists it.

/// \`(code, listed in AGENT_ERROR_CODES)\`.
pub const CODES: [(&str, bool); ${errorCodes.length}] = [
${errorCodes.map((c) => `    (${rustStr(c)}, ${AGENT_ERROR_CODES.includes(c)}),`).join('\n')}
];
`;

const outputs = [
  [`${CRATE}src/door/calls.rs`, callsRs],
  [`${CRATE}src/errors_table.rs`, errorsRs],
  [`${CRATE}src/door/schemas.json`, `${JSON.stringify({ nodes, inputs })}\n`],
  ...parityFiles(),
  [`${CRATE}tests/fixtures/env-parity.golden.json`, `${JSON.stringify({ cases: envCases }, null, 1)}\n`],
];

/** Each file leaves in the shape the repo's checks hold it to: `cargo fmt --check` for Rust, `format:check` for JSON. */
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (file, text) => {
  if (file.endsWith('.rs')) return execFileSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], { input: text, encoding: 'utf8' });
  if (file.endsWith('.json'))
    return execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
  return text;
};

let stale = 0;
for (const [file, raw] of outputs) {
  const text = formatted(file, raw);
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(file, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${file.slice(ROOT.length)}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
const perSlice = Object.keys(SLICES).map((s) => `${s} ${table.filter((c) => c.slice === s).length}`);
console.log(
  `${table.length} calls (${perSlice.join(', ')}), ${nodes.length} schema parts, ${cases.length} input cases, ${errorCodes.length} error codes, ${envCases.length} environments`,
);
for (const line of otherFirstChecks) console.log(`  a handler's own first refusal, the slice's: ${line}`);
if (stale) process.exit(1);
