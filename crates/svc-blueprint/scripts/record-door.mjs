// Records, from the TypeScript svc-blueprint in this checkout, what the Rust crate's shell is held to:
//
// - `src/door/schemas.json`: every call's input and output schema, as the router mounts it from its records
//   (`@intafaced/contracts/blueprint-procedures`), and the row schemas the handlers read rows with, as the tree of zod 4
//   parts the kit's zod engine runs.
// - `tests/fixtures/input-parity.golden.json`: zod's own verdict on a few hundred inputs, made from each schema.
// - `tests/fixtures/refusals.golden.json`: what the router answers for every refusal code a handler can throw
//   (`BlueprintError`, `AttestationSurfaceError`, and any other error), through a guarded call and an unmapped one.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
// - `tests/fixtures/card.golden.json`: the share card `composeCard` draws for a set of subjects at both sizes, what the
//   zero-PII bar (`attestations/zero-pii.ts`) says of a set of payloads, and what `HttpCardRenderer` sends and returns
//   for a set of renderer answers.
//
// Who may call each call is not recorded here: the door reads it from the records' published schema
// (`packages/contracts/procedures/svc-blueprint.schema.json`), the one list of the calls.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-blueprint^..." build`):
//   TZ=UTC node --import tsx crates/svc-blueprint/scripts/record-door.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-blueprint/scripts/record-door.mjs --check  fails when a written file is stale
//
// It reads the TypeScript service and `services/svc-blueprint/src/wire-replay.golden.json`; it never writes there. It
// stops being runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-blueprint/src/`;
const NAME = 'record-door';
if (!existsSync(SVC)) {
  console.error(
    `${NAME}: services/svc-blueprint no longer exists (the Rust crate replaced it); nothing to record from. The files it wrote are the reference now.`,
  );
  process.exit(2);
}
const CHECK = process.argv.includes('--check');

if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC (new Date(text) reads a time with no offset in the local zone)`);
  process.exit(2);
}
// The wire replay's process: vitest's NODE_ENV and the posture its test stubs.
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.INTAFACED_SCREENING_FAIL_CLOSED = 'off';
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

const { createBlueprintRouter } = await import(`${SVC}router.ts`);
const { BlueprintService, BlueprintError } = await import(`${SVC}blueprint-service.ts`);
const { BlueprintRow, MentorMatchRow, OpenerRow, ShareRow } = await import(`${SVC}rows.ts`);
const zeroPii = await import(`${SVC}attestations/zero-pii.ts`);
const { composeCard } = await import(`${SVC}card/compose.ts`);
const { HttpCardRenderer } = await import(`${SVC}card/http-renderer.ts`);
const { responseSchema: RendererResponse } = await import(`${SVC}card/renderer-response.ts`);
// The service's own packages, resolved from the service as its tests resolve them.
const fromService = createRequire(`${SVC}index.ts`);
const load = (name) => import(pathToFileURL(fromService.resolve(name)).href);
const { createEdgeContext, encodePrincipal, signPrincipalHeader } = await load('@intafaced/contracts');
const { default: Fastify } = await load('fastify');
const { fastifyTRPCPlugin } = await load('@trpc/server/adapters/fastify');

/** A dependency nobody wired: any property is another stub, any call refuses with the path it was reached by. */
function stub(name) {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub(`${name}.${prop}`);
    },
    apply() {
      throw new Error(`replay stub: ${name}`);
    },
  });
}

const router = createBlueprintRouter(new BlueprintService(stub('sql'), stub('engine'), stub('bus'), stub('cardRenderer'), {}));
const procedures = router._def.procedures;
const paths = Object.keys(procedures).sort((a, b) => a.localeCompare(b));
const golden = JSON.parse(readFileSync(`${SVC}wire-replay.golden.json`, 'utf8'));
if (JSON.stringify(golden.callers.map((c) => c.path)) !== JSON.stringify(paths)) throw new Error('the router and the recording disagree');

// ── The input schemas ──────────────────────────────────────────────────────────────────────────────────────────────

/** Each refine's function source, named: the Rust crate implements each by its name (`src/refines.rs`). */
const REFINES = {
  '(value) => value.userId !== undefined || value.shareId !== undefined': 'subject_or_share',
  'value=>value.userId!==undefined||value.shareId!==undefined': 'subject_or_share',
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

// ── The output schemas and the rows ────────────────────────────────────────────────────────────────────────────────
// Recorded after the inputs, so an input's parts keep their numbers. Each call's output schema, as tRPC parses what a
// handler returns (`.output(record.output)`: what leaves is its parse, so a key it does not name is dropped). Each row
// schema the handlers check rows with as they read them, as `<Row>.array()` (the issue's path starts at the row).
const outputParts = {};
for (const path of paths) {
  const out = procedures[path]._def.output;
  if (out) outputParts[path] = node(out);
}
const rowParts = {
  BlueprintRow: node(BlueprintRow.array()),
  MentorMatchRow: node(MentorMatchRow.array()),
  ShareRow: node(ShareRow.array()),
  OpenerRow: node(OpenerRow.array()),
  // Not a row: the card renderer's answer (`card/http-renderer.ts`), checked as one.
  RendererResponse: node(RendererResponse.array()),
};

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
  const valid = golden.inputs[path] ? (JSON.parse(golden.inputs[path].sample) ?? undefined) : undefined;
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

// ── The refusals ───────────────────────────────────────────────────────────────────────────────────────────────────

const errorsSource = readFileSync(`${SVC}blueprint-service.ts`, 'utf8');
const union = /readonly code:\s*([\s\S]*?),\n\s*\) \{/.exec(errorsSource)?.[1];
if (!union) throw new Error('blueprint-service.ts: no BlueprintError code union');
const blueprintCodes = [...union.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
const attestationCodes = Object.entries(zeroPii)
  .filter(([k, v]) => k.startsWith('ATTESTATION_') && typeof v === 'string' && v.startsWith('blueprint.'))
  .map(([, v]) => v)
  .sort();

/** Each thrown value the router can meet: every code of each error type, then an error with a code of its own, then a plain one. */
const THROWN = [
  ...blueprintCodes.map((code) => ['blueprint', code, () => new BlueprintError(`replay: ${code}`, code)]),
  ...attestationCodes.map((code) => ['attestation', code, () => new zeroPii.AttestationSurfaceError(`replay: ${code}`, code)]),
  ['coded', 'outside.code', () => Object.assign(new Error('replay: a coded failure'), { code: 'outside.code' })],
  ['plain', '', () => new Error('replay: an unexpected failure')],
];

const SECRET = 'a-placeholder-blueprint-record-door-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const raw = encodePrincipal({
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-333333333333',
  scopes: ['blueprint:read', 'blueprint:write'],
  tier: 'none',
  mfa: false,
  expiresAt: new Date('2099-01-01T00:00:00Z'),
});
const signed = {
  'x-intafaced-principal': raw,
  'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
  'x-intafaced-region': 'DE',
};

/** `card` turns a refusal into its answer by `toTrpcError`; `me` lets it out as tRPC sends an unknown error. */
const VIA = [
  ['card', 'card', '{}'],
  ['me', 'get', null],
];
const refusals = [];
for (const [kind, code, make] of THROWN) {
  const service = new Proxy(new BlueprintService(stub('sql'), stub('engine'), stub('bus'), stub('cardRenderer'), {}), {
    get: (t, prop) => (VIA.some(([, m]) => m === prop) ? () => Promise.reject(make()) : t[prop]),
  });
  const app = Fastify({ genReqId: () => 'replay-request' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createBlueprintRouter(service),
      createContext: ({ req }) => createEdgeContext({ secret: SECRET, serviceName: 'svc-blueprint' })(req),
    },
  });
  await app.ready();
  for (const [path, , input] of VIA) {
    const url = `/trpc/${path}${input === null ? '' : `?input=${encodeURIComponent(input)}`}`;
    const res = await app.inject({ method: 'GET', url, headers: signed });
    refusals.push({ kind, code, via: path, status: res.statusCode, body: res.body });
  }
  await app.close();
}

// ── The environment ────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_BASE = {
  EDGE_PRINCIPAL_SECRET: 'placeholder-blueprint-env-parity-edge-secret',
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://blueprint:blueprint@localhost:5432/blueprint_test',
  DATABASE_POOL_MAX: '4',
  BLUEPRINT_ENGINE_MODE: 'mock',
};
/** Production posture refuses published material: a prod case names its own database and edge secret. */
const PROD = {
  DATABASE_URL: 'postgres://blueprint:a-placeholder-not-published@db.internal:5432/blueprint',
  EDGE_PRINCIPAL_SECRET: 'a-placeholder-blueprint-prod-edge-secret-not-published',
  NATS_URL: 'nats://nats.internal:4222',
  REDIS_URL: 'redis://redis.internal:6379',
};
const ENV_CASES = [
  {},
  { BLUEPRINT_ENGINE_MODE: undefined },
  { BLUEPRINT_ENGINE_MODE: '' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://engine.example:4108' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: '  http://engine.example:4108  ' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: '   ' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'engine' },
  { BLUEPRINT_ENGINE_MODE: 'HTTP' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_CREW_CAPACITY: '1' },
  { BLUEPRINT_ENGINE_MODE: 'http', LOG_LEVEL: 'loud' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_TIMEOUT_MS: '1.5' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_TIMEOUT_MS: 'soon' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_CARD_RENDERER_URL: 'render' },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_API_KEY: '' },
  { BLUEPRINT_ENGINE_MODE: 'http', DATABASE_URL: undefined },
  { BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_SEASON: '9007199254740993' },
  { BLUEPRINT_ENGINE_MODE: 'remote', BLUEPRINT_ENGINE_URL: 'not a url', BLUEPRINT_CREW_CAPACITY: '1' },
  { BLUEPRINT_ENGINE_TIMEOUT_MS: '999', BLUEPRINT_CARD_RENDERER_TIMEOUT_MS: '60001' },
  { BLUEPRINT_ENGINE_TIMEOUT_MS: '120000', BLUEPRINT_CARD_RENDERER_TIMEOUT_MS: '500' },
  { BLUEPRINT_ENGINE_TIMEOUT_MS: '1.5', BLUEPRINT_CARD_RENDERER_TIMEOUT_MS: 'soon' },
  { BLUEPRINT_ENGINE_TIMEOUT_MS: '', BLUEPRINT_CARD_RENDERER_TIMEOUT_MS: ' ' },
  { BLUEPRINT_ENGINE_API_KEY: '', BLUEPRINT_CARD_RENDERER_API_KEY: '' },
  { BLUEPRINT_ENGINE_API_KEY: ' placeholder-engine-key ', BLUEPRINT_CARD_RENDERER_API_KEY: 'placeholder-renderer-key' },
  {
    BLUEPRINT_CREW_CAPACITY: '6',
    BLUEPRINT_MENTOR_SHORTLIST_SIZE: '3',
    BLUEPRINT_SEASON: '1',
    BLUEPRINT_SHARES_PER_OWNER: '0',
    BLUEPRINT_OPENS_LIST_LIMIT: '0',
  },
  {
    BLUEPRINT_CREW_CAPACITY: ' ',
    BLUEPRINT_MENTOR_SHORTLIST_SIZE: '',
    BLUEPRINT_SEASON: '  ',
    BLUEPRINT_SHARES_PER_OWNER: '',
    BLUEPRINT_OPENS_LIST_LIMIT: ' ',
  },
  {
    BLUEPRINT_CREW_CAPACITY: '25',
    BLUEPRINT_MENTOR_SHORTLIST_SIZE: '0',
    BLUEPRINT_SEASON: '0',
    BLUEPRINT_SHARES_PER_OWNER: '-1',
    BLUEPRINT_OPENS_LIST_LIMIT: '1.5',
  },
  { BLUEPRINT_CREW_CAPACITY: ' 6 ', BLUEPRINT_MENTOR_SHORTLIST_SIZE: '11', BLUEPRINT_SEASON: 'one', BLUEPRINT_SHARES_PER_OWNER: '1e3' },
  {
    BLUEPRINT_CREW_CAPACITY: '2',
    BLUEPRINT_MENTOR_SHORTLIST_SIZE: '10',
    BLUEPRINT_SEASON: '9007199254740993',
    BLUEPRINT_OPENS_LIST_LIMIT: '0x10',
  },
  { BLUEPRINT_CARD_RENDERER_URL: '' },
  { BLUEPRINT_CARD_RENDERER_URL: ' ' },
  { BLUEPRINT_CARD_RENDERER_URL: 'https://render.example/card' },
  { BLUEPRINT_CARD_RENDERER_URL: 'render' },
  { HTTP_PORT: '4100', SERVICE_NAME: 'svc-blueprint-2', LOG_LEVEL: 'loud' },
  { HTTP_PORT: '1.5', NODE_ENV: 'staging', SERVICE_NAME: '' },
  { EDGE_PRINCIPAL_SECRET: 'placeholder', EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: '301' },
  { DATABASE_URL: undefined, DATABASE_POOL_MAX: '201', DATABASE_SSL: 'YES', NATS_URL: '  ' },
  { APP_ENV: 'prod' },
  { ...PROD, APP_ENV: 'prod' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://localhost:4108' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://127.8.0.1:4108' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://[::1]:4108' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://[::ffff:7f00:1]:4108' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://localhost.:4108' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://0.0.0.0:4108' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'https://engine.example' },
  { ...PROD, APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://128.0.0.1:4108' },
  { ...PROD, APP_ENV: 'staging', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'http://localhost:4108' },
  { ...PROD, NODE_ENV: 'production', APP_ENV: 'prod', BLUEPRINT_ENGINE_MODE: 'http', BLUEPRINT_ENGINE_URL: 'https://engine.example' },
];

const envProbe = `${CRATE}scripts/env-probe.mjs`;
const envCases = ENV_CASES.map((overrides) => {
  const vars = { ...ENV_BASE, ...overrides };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', envProbe], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TZ: 'UTC', BLUEPRINT_ENV_PROBE: JSON.stringify(vars) },
    encoding: 'utf8',
  });
  return { env: vars, answer: JSON.parse(out) };
});

// ── The card ───────────────────────────────────────────────────────────────────────────────────────────────────────

const AXES = {
  decisionStyle: ['analytical', 'intuitive', 'collaborative', 'decisive'],
  riskTemperament: ['guarded', 'measured', 'assertive', 'bold'],
  energyRhythm: ['dawn', 'steady', 'surge', 'nocturnal'],
  learningMode: ['visual', 'narrative', 'hands_on', 'systematic'],
  crewRole: ['anchor', 'scout', 'builder', 'catalyst'],
  curriculumPath: ['foundations', 'markets', 'sovereign'],
  toneRegister: ['direct', 'warm', 'socratic', 'terse'],
};
const GUARDRAILS = { maxLeverage: 2, dailyLossPromptPct: 5, confirmBeforeMarketOrder: true, copyTradingVisible: false };
const profileAt = (i) => ({
  ...Object.fromEntries(Object.entries(AXES).map(([k, values]) => [k, values[i % values.length]])),
  guardrails: GUARDRAILS,
});
const CREWS = [
  { crewName: 'Iron Meridian', season: 1 },
  { crewName: null, season: null },
  { crewName: 'Quiet Harbour', season: null },
  { crewName: `A&B <"Crew's">`, season: 12 },
];
const subjects = [0, 1, 2, 3].map((i) => ({ profile: profileAt(i), ...CREWS[i] }));
// A token the label table does not hold is drawn as itself.
subjects.push({ profile: { ...profileAt(0), crewRole: 'navigator', toneRegister: 'dry & <odd>' }, crewName: 'Iron Meridian', season: 2 });
const composed = subjects.flatMap((subject) =>
  ['portrait', 'landscape'].map((size) => ({ subject, size, svg: composeCard(subject, size) })),
);

const PII_PAYLOADS = [
  { profile: profileAt(0), crewName: 'Iron Meridian', season: 1 },
  {
    size: 'portrait',
    width: 1080,
    height: 1350,
    svg: '<svg/>',
    raster: { status: 'unavailable', code: 'c', reason: 'r' },
    shareMode: 'svg',
  },
  { profile: { userId: 'x' } },
  [{ 'Phone-Number': 1 }],
  { a: { b: [{ dateOfBirth: 1 }] } },
  { name: 1, email: 2 },
  { Wallet_Address: '0x' },
  { display_name: 'n' },
  { KYC: true },
  { 'public-key': 'k' },
  { accountId: 1 },
  { emailAddress: 'e' },
  { crew_name: 'c', fullName: null },
  { nested: [[{ smartAccount: 1 }]] },
  null,
  'userId',
  [],
  {},
];
// Every key the bar names, each alone and in another spelling, and keys near them that it lets through.
const PII_KEYS = [
  'identity',
  'identityId',
  'legalName',
  'fullName',
  'firstName',
  'lastName',
  'displayName',
  'givenName',
  'name',
  'email',
  'phone',
  'handle',
  'username',
  'avatar',
  'birthData',
  'birthDate',
  'birthTime',
  'birthPlace',
  'governmentId',
  'nationalId',
  'passport',
  'ssn',
  'kyc',
  'kycStatus',
  'kycId',
  'kycDocument',
  'verificationLevel',
  'aml',
  'userId',
  'custodialUserId',
  'customerId',
  'ledgerUserId',
  'accountId',
  'walletAddress',
  'evmAddress',
  'chainAddress',
  'onChainAddress',
  'crossPlaneAddress',
  'smartAccount',
  'intachainAddress',
  'publicKey',
  'phoneNumber',
  'emailAddress',
  'dateOfBirth',
  'date_of_birth',
  'PHONE_NUMBER',
  'crewName',
  'season',
  'names',
  'userIds',
  'birth',
  'address',
  'key',
];
PII_PAYLOADS.push(...PII_KEYS.map((key) => ({ [key]: 1 })));
const zeroPiiCases = PII_PAYLOADS.map((payload) => ({ payload, answer: zeroPii.inspectZeroPiiPayload(payload) }));

const REQUEST = {
  svg: '<svg width="1080"/>',
  size: 'portrait',
  width: 1080,
  height: 1350,
  blueprintId: '77777777-7777-4777-8777-777777777777',
};
const RENDERER_CASES = [
  {
    baseUrl: 'https://render.example',
    apiKey: 'placeholder-renderer-key',
    status: 200,
    body: '{"url":"https://cdn.example/card.png","bytes":84000}',
  },
  { baseUrl: 'https://render.example///', status: 200, body: '{"bytes":1,"url":"https://cdn.example/b.png","extra":true}' },
  { baseUrl: 'https://render.example', status: 201, body: '{"url":"https://cdn.example/c.png","bytes":2}' },
  { baseUrl: 'https://render.example', status: 500, body: '{"url":"https://cdn.example/c.png","bytes":2}' },
  { baseUrl: 'https://render.example', status: 404, body: 'gone' },
  { baseUrl: 'https://render.example', status: 200, body: 'not json' },
  { baseUrl: 'https://render.example', status: 200, body: '' },
  { baseUrl: 'https://render.example', status: 200, body: '{"url":"nope","bytes":0}' },
  { baseUrl: 'https://render.example', status: 200, body: '[]' },
  { baseUrl: 'https://render.example', status: 200, body: 'null' },
  { baseUrl: 'https://render.example', status: 200, body: '{"url":"https://cdn.example/d.png","bytes":1.5}' },
  { baseUrl: 'https://render.example', status: 200, body: '{"bytes":-1.5}' },
  { baseUrl: 'https://render.example', status: 200, body: '{"url":7,"bytes":"84000"}' },
  { baseUrl: 'https://render.example', throws: 'fetch failed' },
  { baseUrl: 'https://render.example', throws: 'timeout', timeoutMs: 5 },
];
const rendererCases = [];
for (const c of RENDERER_CASES) {
  let sent;
  const fetchImpl = (url, init) => {
    sent = { method: init.method, url, headers: Object.entries(init.headers), body: init.body };
    if (c.throws === 'fetch failed') return Promise.reject(new TypeError('fetch failed'));
    if (c.throws === 'timeout') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return Promise.resolve(new Response(c.body, { status: c.status }));
  };
  const renderer = new HttpCardRenderer({
    baseUrl: c.baseUrl,
    ...(c.apiKey ? { apiKey: c.apiKey } : {}),
    ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
    fetchImpl,
  });
  const answer = await renderer.rasterize(REQUEST);
  rendererCases.push({ case: c, sent, answer });
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const verdictList = [];
const verdictAt = new Map();
const rows = cases.map(([path, input, v]) => {
  if (!verdictAt.has(v)) verdictAt.set(v, verdictList.push(v) - 1);
  return JSON.stringify([path, input, verdictAt.get(v)]);
});

const outputs = [
  [`${CRATE}src/door/schemas.json`, `${JSON.stringify({ nodes, inputs, outputs: outputParts, rows: rowParts })}\n`],
  [
    `${CRATE}tests/fixtures/input-parity.golden.json`,
    `{"verdicts":${JSON.stringify(verdictList)},"bases":${JSON.stringify(bases)},"cases":[${rows.join(',')}]}\n`,
  ],
  [`${CRATE}tests/fixtures/refusals.golden.json`, `${JSON.stringify({ refusals }, null, 1)}\n`],
  [`${CRATE}tests/fixtures/env-parity.golden.json`, `${JSON.stringify({ cases: envCases }, null, 1)}\n`],
  [
    `${CRATE}tests/fixtures/card.golden.json`,
    `${JSON.stringify({ request: REQUEST, composed, zeroPii: zeroPiiCases, renderer: rendererCases }, null, 1)}\n`,
  ],
];

/** Each file leaves in the shape the repo's checks hold it to: `format:check` for JSON. */
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (file, text) =>
  file.endsWith('.json') ? execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 }) : text;

let stale = 0;
for (const [file, text0] of outputs) {
  const text = formatted(file, text0);
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
console.log(
  `${paths.length} calls, ${nodes.length} schema parts, ${cases.length} input cases, ${refusals.length} refusal answers, ${envCases.length} environments`,
);
if (stale) process.exit(1);
