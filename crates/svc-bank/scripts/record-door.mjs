// Records, from the TypeScript svc-bank in this checkout, what the Rust crate's door is held to:
//
// - `src/door/calls.rs`: every call's path, query or mutation, who may call it (public, svc-bank's own job twin, a
//   listed service, or one scope or any of several with their guards), and which slice owns it. Each is read from the
//   call's middlewares themselves, run on probe callers.
// - `src/door/schemas.json`: every call's input schema, as the tree of zod 4 parts the kit's zod engine runs.
// - `src/errors_table.rs`: every `BankErrorCode` with the tRPC code it answers, and the customer's sentence for the codes
//   `user-copy.ts` lets a caller read.
// - `tests/fixtures/input-parity/`: zod's own verdict on a few thousand inputs, made from each schema.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
// - `tests/fixtures/guard-grid.golden.json`: what each guarded call's middlewares answer a grid of callers.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-bank^..." build`):
//   TZ=UTC node --import tsx crates/svc-bank/scripts/record-door.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-bank/scripts/record-door.mjs --check  fails when a written file is stale
//
// It reads the TypeScript service and `services/svc-bank/src/wire-replay.golden/`; it never writes there. It stops being
// runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-bank/src/`;
const NAME = 'record-door';
if (!existsSync(SVC)) {
  console.error(
    `${NAME}: services/svc-bank no longer exists (the Rust crate replaced it); nothing to record from. The files it wrote are the reference now.`,
  );
  process.exit(2);
}
const CHECK = process.argv.includes('--check');

if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC (new Date(text) reads a time with no offset in the local zone)`);
  process.exit(2);
}
// The wire replay's process: vitest's NODE_ENV, and svc-bank's vitest env.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

const fromService = createRequire(`${SVC}index.ts`);
const load = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const svc = (p) => import(`${SVC}${p}`);
const { SCOPES } = await load('@intafaced/auth');
const { BANK_ERROR_STATUS } = await svc('errors.ts');
const { isUserVisibleBankCopyCode, userCopy } = await svc('user-copy.ts');
const { publicDoorWireMessage } = await svc('router/errors.ts');
const { BankError } = await svc('errors.ts');

// ── The router, as the wire replay builds it ───────────────────────────────────────────────────────────────────────

const { createBankServices, unconfiguredRecipientState } = await svc('bank-service.ts');
const { createBankRouter } = await svc('router.ts');
const { createStepUpGate } = await svc('step-up/step-up-gate.ts');
const { unwiredApprovalConsumer } = await svc('action-approval-consume.ts');
const { unconfiguredExtraControls } = await svc('safety/extra-controls.ts');
const { unconfiguredBusinessDirectory } = await svc('business/business-directory.ts');
const { unconfiguredSecurityLock } = await svc('security-lock.ts');
const { unconfiguredApprovalMail } = await svc('ramps/address-approval.ts');
const { unconfiguredTrustedDevices } = await svc('ramps/trusted-devices.ts');
const { unconfiguredIdentityRecovery } = await svc('recovery/identity-recovery.ts');
const { cardIssuerFor } = await svc('cards/issuer.ts');
const { rampProgrammeFor } = await svc('ramps/rails.ts');
const { destinationSanctions } = await svc('ramps/sanctions-list.ts');

/** The recorder's own placeholder secret: it signs only the recorder's probe requests. */
const INTERNAL = 'placeholder-bank-record-door-internal-secret';

/** A dependency nobody wired, as the wire replay's `stub`: any call refuses with the path it was reached by. */
function stub(name) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub(`${name}.${prop}`);
    },
    apply() {
      throw new Error(`replay stub: ${name}`);
    },
    construct() {
      throw new Error(`replay stub: new ${name}`);
    },
  });
}

/** `createReplayBankRouter` of `wire-replay.test.ts`, option for option. */
function replayRouter() {
  const sql = stub('sql');
  const bank = createBankServices(sql, stub('ledger'), stub('history'), {
    testPartner: null,
    bankApi: { allowLocalHttp: false },
    postingFreeze: stub('postingFreeze'),
    identityRecovery: unconfiguredIdentityRecovery(),
    receiptSecret: INTERNAL,
    deposits: { custody: stub('payCustodyDeposits'), addressCap: () => undefined, addressExpiryDays: () => undefined },
    assetRegistry: stub('assetRegistry'),
    recipients: unconfiguredRecipientState(),
    requestNotices: stub('requestNotices'),
    transferNotices: stub('transferNotices'),
    scheduledNotices: stub('scheduledNotices'),
    directory: unconfiguredBusinessDirectory(),
    activity: { pages: stub('historyPages'), cursorSecret: INTERNAL, payWithdrawals: stub('payWithdrawals') },
    statementJobs: { leaseMs: null, testRenderHoldMs: null },
    loans: { priceSource: stub('tradePrices'), marginCalls: stub('marginCalls'), moduleEnabled: true },
    cardProgramme: { sanctions: () => undefined, simulatorAllowed: false },
    cards: {
      issuer: cardIssuerFor('none', { APP_ENV: 'test' }),
      cashbackEarned: stub('cashbackEarned'),
      rates: stub('cardRates'),
      moduleEnabled: true,
    },
    portfolio: { tickers: stub('tickers'), pages: stub('portfolioPages'), history: stub('holdingsHistory'), closes: stub('closes') },
    autoInvest: { enabled: true },
    ramps: {
      programme: rampProgrammeFor('none'),
      sanctions: destinationSanctions(() => undefined),
      securityLock: unconfiguredSecurityLock(),
      approvalMail: unconfiguredApprovalMail(),
      trustedDevices: unconfiguredTrustedDevices(),
    },
  });
  const approvals = unwiredApprovalConsumer();
  return createBankRouter(bank, {
    extraControls: unconfiguredExtraControls(),
    scheduledTransfersEnabled: true,
    interestAccrualEnabled: true,
    loanAccrualEnabled: true,
    loanRiskSweepEnabled: false,
    autoInvestEnabled: true,
    autoInvestConvertWired: false,
    approvals,
    stepUp: createStepUpGate({ mode: 'off', approvals, store: stub('stepUpUses') }),
    statementStepUp: createStepUpGate({ mode: 'required', approvals, store: stub('stepUpUses') }),
    ownMoveStepUp: createStepUpGate({ mode: 'required', approvals, store: stub('stepUpUses') }),
  });
}

const router = replayRouter();
const procedures = Object.fromEntries(Object.entries(router._def.procedures).filter(([, p]) => p._def.type !== 'subscription'));
const paths = Object.keys(procedures).sort((a, b) => a.localeCompare(b));

const GOLDEN_DIR = `${SVC}wire-replay.golden/`;
const goldenCallers = JSON.parse(readFileSync(`${GOLDEN_DIR}callers.json`, 'utf8'));
const goldenInputs = Object.assign(
  {},
  ...readdirSync(GOLDEN_DIR)
    .filter((n) => n.endsWith('.json') && n !== 'callers.json')
    .sort()
    .map((n) => JSON.parse(readFileSync(`${GOLDEN_DIR}${n}`, 'utf8')).inputs),
);
const golden = {
  callers: [...goldenCallers].sort((a, b) => a.path.localeCompare(b.path)),
  /** The two inputs the replay made from each call's schema: `sample`, then `sample-nulls`. */
  valid: Object.fromEntries(Object.entries(goldenInputs).map(([k, v]) => [k, JSON.parse(v.sample)])),
  nulls: Object.fromEntries(Object.entries(goldenInputs).map(([k, v]) => [k, JSON.parse(v['sample-nulls'])])),
};
if (JSON.stringify(golden.callers.map((c) => c.path)) !== JSON.stringify(paths)) throw new Error('the router and the recording disagree');

// ── Who owns each call ─────────────────────────────────────────────────────────────────────────────────────────────

/** The slices (one Rust module each, `PORT.md`'s `## Slices`), and the calls each owns: exact paths, then `prefix*`. */
const SLICES = JSON.parse(readFileSync(`${CRATE}scripts/slices.json`, 'utf8'));

/** The REST doors' slices (`src/door/rest.rs`'s `DOORS`). */
const REST_SLICES = {
  'POST /internal/closure-check': 'partner-account',
  'POST /internal/agents/team-membership': 'business',
  'POST /internal/agents/usage-payment': 'partner',
};

function sliceOf(path) {
  if (Object.hasOwn(REST_SLICES, path)) return REST_SLICES[path];
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
const ALL_SCOPES = [...SCOPES];
/** Every service, TypeScript or moved to Rust, that a `serviceProcedureFor` list might name. */
const SERVICES = [...new Set([...readdirSync(`${ROOT}services`), ...readdirSync(`${ROOT}crates`)])]
  .filter((n) => n.startsWith('svc-'))
  .sort();

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
const flat = (fn) => fn.toString().replace(/\s+/g, ' ').trim();

const isAuth = (src) => src.includes("'Authentication required'") && src.includes('!ctx.principal');
const SCOPED_SRC = flat((await load('@intafaced/contracts')).scopedProcedure('bank:read')._def.middlewares.at(-1));
const ANY_SRC = flat((await load('@intafaced/contracts')).anyScopeProcedure(['bank:read'])._def.middlewares.at(-1));
const isServiceFor = (src) => src.includes('requireServiceCaller(ctx.service)') && src.includes('callers.includes(ctx.service)');
const isJob = (src) =>
  /^\(\{\s*ctx,\s*next\s*\}\)\s*=>\s*\{\s*requireBankJobService\(ctx\.service\);?\s*return next\(\{\s*ctx\s*\}\);?\s*\}$/.test(src);

const KYC = /^FORBIDDEN Verification tier "([a-z]+)" required for ([a-z-]+) in DE$/;

/** The scoped middleware's guards, read by running it: its scope, the tier, whether a service is refused, the module, own session. */
async function scopedGuards(path, mw) {
  const ctx = (over) => ({ principal: principal(), region: 'DE', service: null, ...over });
  const missing = said(await run(mw, ctx({ principal: principal({ scopes: [] }) })));
  const scope = /^FORBIDDEN Scope "([a-z:]+)" is required$/.exec(missing ?? '')?.[1];
  if (!scope) throw new Error(`${path}: the scoped middleware named no scope (${missing})`);
  const only = (over) => ctx({ principal: principal({ scopes: [scope], ...over }) });
  const own = said(await run(mw, only({})));
  if (own) throw new Error(`${path}: the scoped middleware refused its own scope: ${own}`);
  const service = said(await run(mw, { ...only({}), service: 'svc-trade' }));
  const person = service === 'FORBIDDEN A signed-in user session is required';
  if (service !== null && !person) throw new Error(`${path}: a service refused as ${service}`);
  // `guards.tier` (requireTier, inside the scope's try): the lowest tier it lets through, read from its refusal.
  const TIERS = ['none', 'basic', 'full', 'institutional'];
  const TIER_SAID = /^FORBIDDEN Verification tier "([a-z]+)" is required$/;
  let tier = null;
  const atNone = said(await run(mw, only({ tier: 'none' })));
  const t = TIER_SAID.exec(atNone ?? '');
  if (t) tier = t[1];
  const lowest = tier ?? 'none';
  const region = said(await run(mw, { ...only({ tier: 'institutional' }), region: 'US' }));
  // The module (a region the matrix refuses): its own tier rule, read where the tier guard lets a caller through.
  let module = null;
  if (region !== null) {
    if (!region.startsWith('FORBIDDEN ')) throw new Error(`${path}: the region refused as ${region}`);
    module = { kyc: null };
    for (const at of TIERS.slice(TIERS.indexOf(lowest))) {
      const r = said(await run(mw, only({ tier: at })));
      if (r === null) break;
      const k = KYC.exec(r);
      if (!k) throw new Error(`${path}: a tier refusal the door does not know: ${r}`);
      module.kyc = { id: k[2], minTier: k[1] };
      break;
    }
    if (module.kyc === null && tier === null) throw new Error(`${path}: a module that asks no tier: the door's Module needs its rule`);
  } else if (atNone !== null && !t) throw new Error(`${path}: a refusal at tier none with no module: ${atNone}`);
  // `ownSession`: a key and a sub-account refused alike with the call's own code. A key refused for an interactive-only
  // scope is the kit's scope rule, which the door already runs; the sub-account then says whether the call adds its own.
  let key = said(await run(mw, only({ kid: 'key-1' })));
  if (key && /requires an interactive session/.test(key)) key = null;
  const subAccount = said(await run(mw, only({ sub_account: SUB })));
  let ownSession = null;
  if (key !== null || subAccount !== null) {
    if (subAccount === null || (key !== null && key !== subAccount) || !subAccount.startsWith('FORBIDDEN ')) {
      throw new Error(`${path}: a key / sub-account check ${key} / ${subAccount}`);
    }
    ownSession = subAccount.slice('FORBIDDEN '.length);
  }
  return { scope, tier, person, module, ownSession };
}

/** `anyScopeProcedure`'s scopes, read from its refusal, and its module. */
async function anyGuards(path, mw) {
  const ctx = (over) => ({ principal: principal(), region: 'DE', service: null, ...over });
  const missing = said(await run(mw, ctx({ principal: principal({ scopes: [] }) })));
  const m = /^FORBIDDEN One of ([a-z:, ]+) is required$/.exec(missing ?? '');
  if (!m) throw new Error(`${path}: anyScope named no scopes (${missing})`);
  const scopes = m[1].split(', ');
  const service = said(await run(mw, { ...ctx({}), service: 'svc-trade' }));
  const person = service === 'FORBIDDEN A signed-in user session is required';
  if (service !== null && !person) throw new Error(`${path}: a service refused as ${service}`);
  if (said(await run(mw, { ...ctx({}), region: 'US' })) !== null) throw new Error(`${path}: an anyScope module the door does not hold`);
  if (said(await run(mw, ctx({ principal: principal({ tier: 'none' }) }))) !== null) throw new Error(`${path}: an anyScope tier`);
  return { scopes, person };
}

/** The checks a call runs before its input, from its middlewares in order. */
async function chainOf(path, proc) {
  const mws = proc._def.middlewares.filter(
    (m) => m.name !== 'outputValidatorMiddleware' && m.name !== 'resolveMiddleware' && m.name !== 'errorFormatterMiddleware',
  );
  const out = { access: { t: 'public' } };
  const rest = [...mws];
  if (rest[0] && isAuth(flat(rest[0]))) {
    rest.shift();
    const src = rest[0] ? flat(rest[0]) : '';
    if (src === SCOPED_SRC) out.access = { t: 'scope', ...(await scopedGuards(path, rest.shift())) };
    else if (src === ANY_SRC) out.access = { t: 'any', ...(await anyGuards(path, rest.shift())) };
    else throw new Error(`${path}: signed in, but not through scopedProcedure or anyScopeProcedure`);
  } else if (rest[0] && isServiceFor(flat(rest[0]))) {
    const mw = rest.shift();
    const callers = [];
    for (const s of SERVICES) if ((await run(mw, { principal: null, region: 'DE', service: s })) === null) callers.push(s);
    out.access = { t: 'service', callers };
  } else if (rest[0] && isJob(flat(rest[0]))) {
    rest.shift();
    out.access = { t: 'job' };
  }
  if (rest[0] && rest[0]._type === 'input') rest.shift();
  if (rest.length) throw new Error(`${path}: a middleware the door does not know: ${flat(rest[0]).slice(0, 200)}`);
  return out;
}

// ── The input schemas ──────────────────────────────────────────────────────────────────────────────────────────────

/** Each refine's function source, named: the Rust crate implements each by its name (`src/door/refines.rs`). */
const REFINES = {
  'value=>value===PERSONAL_PROFILE||BUSINESS_PROFILE.test(value)': 'account_profile',
  'value=>!/[\\u0000-\\u001F]/.test(value)': 'no_control_characters',
  'value=>value.text!==void 0||value.reportDescription!==void 0': 'note_or_report',
  'value=>/[1-9]/.test(value)': 'some_nonzero_digit',
  '(v) => /[1-9]/.test(v)': 'some_nonzero_digit',
  'day=>{const at=new Date(`${day}T00:00:00.000Z`);return!Number.isNaN(at.getTime())&&at.toISOString().slice(0,10)===day}': 'calendar_day',
  'value=>Object.keys(value).length<=8': 'at_most_eight_keys',
  '(input) => input.fromUserId !== input.toUserId': 'two_different_users',
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
  if (d.when && !(['min_length', 'max_length', 'length_equals'].includes(d.check) && d.when.toString().includes(LENGTH_WHEN))) {
    throw new Error(`a check with its own when: ${d.check}`);
  }
  switch (d.check) {
    case 'min_length':
      return out('min_length', { n: d.minimum });
    case 'max_length':
      return out('max_length', { n: d.maximum });
    case 'length_equals':
      return out('length_equals', { n: d.length });
    case 'string_format':
      if (d.format === 'regex') return out('regex', { src: d.pattern.toString() });
      if (d.format === 'starts_with') return out('starts_with', { prefix: d.prefix });
      if (d.format === 'url') {
        for (const k of ['normalize', 'hostname', 'protocol']) if (k in d) throw new Error(`url with ${k}`);
        return out('url');
      }
      if (['guid', 'uuid', 'datetime', 'date'].includes(d.format)) return out('format', { format: d.format, src: d.pattern.toString() });
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
    case 'readonly':
      return withChecks({ t: 'readonly', in: node(d.innerType) });
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
// The REST doors' bodies that a contract schema checks, under the door's name (`src/door/rest.rs`).
const { agentsTeamMembershipRequestSchema, agentsUsagePaymentRequestSchema } = await load('@intafaced/contracts');
const REST_SCHEMAS = {
  'POST /internal/agents/team-membership': agentsTeamMembershipRequestSchema,
  'POST /internal/agents/usage-payment': agentsUsagePaymentRequestSchema,
};
for (const [name, schema] of Object.entries(REST_SCHEMAS)) inputs[name] = node(schema);

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
for (const path of [...paths, ...Object.keys(REST_SCHEMAS)]) {
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
  const valid = golden.valid[path];
  const nullsOf = golden.nulls[path];
  const mine = sample(id);
  if (seenRoots.has(id)) {
    add(mine);
    add(valid);
    add(nullsOf);
    continue;
  }
  seenRoots.set(id, path);
  for (const v of [undefined, null, 7, 'x', [], {}, valid, nullsOf, mine]) add(v);
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

// ── The door table ────────────────────────────────────────────────────────────────────────────────────────────────

const table = [];
for (const c of golden.callers) {
  const proc = procedures[c.path];
  const chain = await chainOf(c.path, proc);
  const recorded = { public: 'public', service: 'service', job: 'public', scope: 'scope', any: 'scope' }[chain.access.t];
  if (recorded !== c.caller) throw new Error(`${c.path}: the recording names its caller ${c.caller}, the chain ${chain.access.t}`);
  table.push({ path: c.path, kind: c.type, ...chain, slice: sliceOf(c.path), hasInput: inputs[c.path] !== undefined });
}

// ── The guard grid ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every guarded call's middlewares before its input, run in order on one grid of callers: no one, or a signed person
 * with no scope or every scope, at each tier, with and without a second factor, on a session, a key or a sub-account;
 * each in a served and an unserved region, with and without a signing service. The first refusal, or `null`, is the
 * answer the door must give (`tests/guard_grid.rs`): the tier, the module's KYC rule and the region are held here,
 * where the wire replay's five callers do not reach.
 */
const GRID = [];
for (const region of ['DE', 'US']) for (const service of [null, 'svc-bank', 'svc-trade']) GRID.push({ principal: null, region, service });
for (const scopes of ['none', 'all'])
  for (const tier of ['none', 'basic', 'full', 'institutional'])
    for (const mfa of [false, true])
      for (const session of ['session', 'key', 'sub-account'])
        for (const region of ['DE', 'US'])
          for (const service of [null, 'svc-trade']) GRID.push({ principal: { scopes, tier, mfa, session }, region, service });

const probeCtx = (g) => ({
  region: g.region,
  service: g.service,
  principal:
    g.principal &&
    principal({
      scopes: g.principal.scopes === 'all' ? ALL_SCOPES : [],
      tier: g.principal.tier,
      mfa: g.principal.mfa,
      ...(g.principal.session === 'key' ? { kid: 'key-1' } : {}),
      ...(g.principal.session === 'sub-account' ? { sub_account: SUB } : {}),
    }),
});

/** The answers' alphabet: one character per probe, naming the call's distinct answers in the order first met. */
const MARKS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const guardGrid = {};
for (const c of table) {
  if (c.access.t === 'public') continue;
  const mws = procedures[c.path]._def.middlewares;
  const guards = mws.slice(
    0,
    mws.findIndex((m) => m._type === 'input' || m.name === 'resolveMiddleware' || m.name === 'outputValidatorMiddleware'),
  );
  const answers = [];
  let marks = '';
  for (const g of GRID) {
    let answer = null;
    for (const mw of guards) {
      answer = said(await run(mw, probeCtx(g)));
      if (answer !== null) break;
    }
    if (!answers.includes(answer)) answers.push(answer);
    marks += MARKS[answers.indexOf(answer)];
  }
  guardGrid[c.path] = { answers, marks };
}

// ── The error catalogue ────────────────────────────────────────────────────────────────────────────────────────────

/** Each code, its tRPC code, and the sentence `publicDoorWireMessage` sends for it when the message the code was thrown with is `<operator>`. */
const OPERATOR = '<operator>';
const errorRows = Object.entries(BANK_ERROR_STATUS).map(([code, trpc]) => {
  const wire = publicDoorWireMessage(new BankError(OPERATOR, code));
  const visible = isUserVisibleBankCopyCode(code);
  if (visible && wire.includes(OPERATOR)) throw new Error(`${code}: a user-visible code whose copy keeps the operator's words`);
  const copy = visible ? userCopy(code) : null;
  // The wire message is the copy (or the operator's sentence), with ` (<code>)` added for the codes that carry it.
  const facing = copy ?? OPERATOR;
  let suffix;
  if (wire === facing) suffix = false;
  else if (wire === `${facing} (${code})`) suffix = true;
  else throw new Error(`${code}: a wire message the table cannot say: ${wire}`);
  return { code, trpc, copy, suffix };
});

// ── The environment ────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_BASE = {
  EDGE_PRINCIPAL_SECRET: 'placeholder-bank-env-parity-edge-secret-long',
  INTERNAL_SERVICE_SECRET: 'placeholder-bank-env-parity-internal-secret',
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://bank:bank@localhost:5432/bank_test',
  DATABASE_POOL_MAX: '4',
  TRANSFER_BATCH_SIZE: '200',
  LOAN_QUOTE_ASSET_ID: 'USDC',
  LOAN_SWEEP_BATCH_SIZE: '100',
};
const ENV_CASES = JSON.parse(readFileSync(`${CRATE}scripts/env-cases.json`, 'utf8'));

const envProbe = `${CRATE}scripts/env-probe.mjs`;
const envCases = ENV_CASES.map((overrides) => {
  const vars = { ...ENV_BASE, ...overrides };
  for (const [k, v] of Object.entries(vars)) if (v === null) delete vars[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', envProbe], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TZ: 'UTC', BANK_ENV_PROBE: JSON.stringify(vars) },
    encoding: 'utf8',
  });
  return { env: vars, answer: JSON.parse(out) };
});

/**
 * The parity fixture, one file per slice the CI review can read whole (`input-parity/<slice>.golden.json`): the slice's
 * distinct verdicts and base inputs once, and its cases, each naming its verdict and base by index in its own file.
 */
function parityFiles() {
  const bySlice = new Map();
  for (const [path, input, v] of cases) {
    const slice = sliceOf(path);
    if (!bySlice.has(slice)) bySlice.set(slice, { verdicts: [], vAt: new Map(), bases: [], bAt: new Map(), rows: [] });
    const f = bySlice.get(slice);
    if (!f.vAt.has(v)) f.vAt.set(v, f.verdicts.push(v) - 1);
    let local = input;
    if (Array.isArray(input) && typeof input[0] === 'number') {
      const text = bases[input[0]];
      if (!f.bAt.has(text)) f.bAt.set(text, f.bases.push(text) - 1);
      local = [f.bAt.get(text), input[1], input[2]];
    }
    f.rows.push(JSON.stringify([path, local, f.vAt.get(v)]));
  }
  const dir = `${CRATE}tests/fixtures/input-parity/`;
  return [...bySlice].map(([slice, f]) => [
    `${dir}${slice}.golden.json`,
    `{"verdicts":${JSON.stringify(f.verdicts)},"bases":${JSON.stringify(f.bases)},"cases":[${f.rows.join(',')}]}`,
  ]);
}

// ── The closure check's body ───────────────────────────────────────────────────────────────────────────────────────

const { parseClosureCheckBody } = await svc('closure/closure-check.ts');
const U = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-9222-222222222222';
const CLOSURE_BODIES = [
  undefined,
  null,
  7,
  'x',
  [],
  {},
  { userId: U, subAccountIds: [] },
  { userId: U.toUpperCase(), subAccountIds: [V.toUpperCase(), V] },
  { userId: U, subAccountIds: [], scope: 'account' },
  { userId: U, subAccountIds: [], scope: 'sub_accounts' },
  { userId: U, subAccountIds: [U.toUpperCase()], scope: 'sub_accounts' },
  { userId: U, subAccountIds: [V], scope: 'sub_accounts' },
  { userId: U, subAccountIds: [V], scope: 'other' },
  { userId: U, subAccountIds: [V], scope: null },
  { userId: U, subAccountIds: 'x' },
  { userId: U },
  { subAccountIds: [] },
  { userId: 'not-a-uuid', subAccountIds: [] },
  { userId: '11111111-1111-0111-8111-111111111111', subAccountIds: [] },
  { userId: '11111111-1111-9111-8111-111111111111', subAccountIds: [] },
  { userId: '11111111-1111-4111-c111-111111111111', subAccountIds: [] },
  { userId: U, subAccountIds: [7] },
  { userId: U, subAccountIds: ['nope'] },
  { userId: U, subAccountIds: Array.from({ length: 100 }, () => V) },
  { userId: U, subAccountIds: Array.from({ length: 101 }, () => V) },
  { userId: U, subAccountIds: [], extra: true },
];
const closureCases = CLOSURE_BODIES.map((b) => [b === undefined ? null : JSON.stringify(b), parseClosureCheckBody(b) !== null]);

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = '// @generated by crates/svc-bank/scripts/record-door.mjs from the TypeScript svc-bank. Do not edit by hand.\n';
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
    case 'job':
      return 'Access::Job';
    case 'service':
      return `Access::Service(&[${a.callers.map(rustStr).join(', ')}])`;
    case 'any':
      return `Access::AnyScope { scopes: &[${a.scopes.map(rustStr).join(', ')}], person: ${a.person} }`;
    case 'scope': {
      const kyc = (k) => (k ? `Some(Kyc { module: ${rustStr(k.id)}, min_tier: ${rustStr(k.minTier)} })` : 'None');
      const module = a.module ? `Some(Region { kyc: ${kyc(a.module.kyc)} })` : 'None';
      const tier = a.tier ? `Some(${rustStr(a.tier)})` : 'None';
      const own = a.ownSession ? `Some(${rustStr(a.ownSession)})` : 'None';
      return `Access::Scope(Scoped { scope: ${rustStr(a.scope)}, tier: ${tier}, person: ${a.person}, region: ${module}, own_session: ${own} })`;
    }
    default:
      throw new Error(`access ${a.t}`);
  }
}

const sliceNames = Object.keys(SLICES);
const callsRs = `${HEADER}//! Every call the door serves, sorted by path as \`procedureCallers\` sorts it, and the slices that own them.

use super::{Access, Call, Kind, Kyc, Region, Scoped};

/// Which slice of the port owns a call's handler (\`PORT.md\`, \`## Slices\`). \`Door\` is answered by the door (\`health\`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Slice {
${sliceNames.map((s) => `    ${sliceType(s)},`).join('\n')}
}

impl Slice {
    pub const ALL: [Slice; ${sliceNames.length}] = [${sliceNames.map((s) => `Slice::${sliceType(s)}`).join(', ')}];

    /// The slice's name in \`PORT.md\`.
    pub fn name(self) -> &'static str {
        match self {
${sliceNames.map((s) => `            Slice::${sliceType(s)} => ${rustStr(s)},`).join('\n')}
        }
    }
}

/// The ${table.length} calls.
pub static CALLS: [Call; ${table.length}] = [
${table
  .map(
    (c) => `    Call {
        path: ${rustStr(c.path)},
        kind: Kind::${c.kind === 'query' ? 'Query' : 'Mutation'},
        access: ${accessRs(c.access)},
        slice: Slice::${sliceType(c.slice)},
        has_input: ${c.hasInput},
    },`,
  )
  .join('\n')}
];
`;

const errorsRs = `${HEADER}//! Every \`BankErrorCode\` (\`BANK_ERROR_STATUS\`, \`services/svc-bank/src/errors.ts\`, in its order): the tRPC code it
//! answers, the customer's sentence when \`user-copy.ts\` lets a caller read one, and whether \`publicDoorWireMessage\`
//! adds \` (<code>)\`.

/// One code's row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    pub code: &'static str,
    pub trpc: &'static str,
    /// The sentence sent in place of the operator's (\`userFacingBankMessage\`).
    pub copy: Option<&'static str>,
    /// \` (<code>)\` follows the sentence.
    pub suffix: bool,
}

pub static CODES: [Row; ${errorRows.length}] = [
${errorRows.map((r) => `    Row { code: ${rustStr(r.code)}, trpc: ${rustStr(r.trpc)}, copy: ${r.copy === null ? 'None' : `Some(${rustStr(r.copy)})`}, suffix: ${r.suffix} },`).join('\n')}
];
`;

const outputs = [
  [`${CRATE}src/door/calls.rs`, callsRs],
  [`${CRATE}src/errors_table.rs`, errorsRs],
  [`${CRATE}src/door/schemas.json`, `${JSON.stringify({ nodes, inputs })}\n`],
  ...parityFiles(),
  [`${CRATE}tests/fixtures/guard-grid.golden.json`, `${JSON.stringify({ scopes: ALL_SCOPES.join(' '), grid: GRID, calls: guardGrid })}\n`],
  [`${CRATE}tests/fixtures/closure-body.golden.json`, `${JSON.stringify({ cases: closureCases })}\n`],
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
const perSlice = sliceNames.map((s) => `${s} ${table.filter((c) => c.slice === s).length}`);
console.log(
  `${table.length} calls (${perSlice.join(', ')}), ${nodes.length} schema parts, ${cases.length} input cases, ${Object.keys(guardGrid).length * GRID.length} guard probes, ${errorRows.length} error codes, ${envCases.length} environments`,
);
if (stale) process.exit(1);
