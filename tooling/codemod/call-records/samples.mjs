#!/usr/bin/env node
// The samples step of the call-records codemod: for each record it wrote (still holding its placeholder samples), an
// input the record accepts, one it refuses, and for each input check it names one that check alone refuses, each found by
// trying candidates against the record's own built schema.
// Run after `pnpm --filter @intafaced/contracts build`; it rewrites the placeholder in the record's source file.
//
//   node tooling/codemod/call-records/samples.mjs <record file.ts> ...
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { KEY_MAPS, quietIssue, quietRefineAt } from './door-refine.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
// The records' own zod: the one @intafaced/contracts resolves.
const { z } = await import(pathToFileURL(createRequire(join(REPO, 'packages/contracts/package.json')).resolve('zod')).href);
// The placeholder index.mjs writes, however prettier wrapped it, with one refused placeholder per input check portable.mjs
// named (`{ verdict: 'refuse', input: 42, by: 'name' }`).
const PLACEHOLDER =
  /samples: \[\s*\{ verdict: 'accept', input: \{\} \},\s*\{ verdict: 'refuse', input: 42 \}(?:,\s*\{ verdict: 'refuse', input: 42, by: '[\w.]+' \})*,?\s*\]/;

const STRINGS = [
  'USDC',
  'x',
  'a',
  '1',
  '0',
  // A self-declaring placeholder ahead of 'abc': a `key` or `token` field sampled 'abc' reads as a committed credential to
  // the secret scan (tooling/ci/secret-scan.mjs PLACEHOLDER_VALUES), 'sample' says what it is.
  'sample',
  'abc',
  'ethereum',
  '11111111-1111-4111-8111-111111111111',
  '2026-01-01',
  '2026-01-01T00:00:00.000Z',
  'a@example.com',
  'https://example.com',
  `0x${'1'.repeat(40)}`,
  'BTC-USD',
  'en',
  'US',
  'GB',
  '10',
  '1.5',
  '00:00',
  'monthly',
];

/** Values a JSON Schema allows, most likely first (`depth` keeps nested objects small). */
// A field named like a credential gets a value the secret scan reads as one (tooling/ci/secret-scan.mjs: /placeholder/i).
const CREDENTIAL_KEY = /pass(word|phrase)?|token|secret|api[_-]?key|private|credential|(?:^|[._-])keys?$/i;

/** A string matching an anchored `[<prefix>][<class>]{m,n}` / `+` / `*` pattern (e.g. `^announcement:[0-9a-f]{16,64}$`, `^[a-f0-9]{64}$`). */
function sampleFromPattern(pattern) {
  const m = /^\^([A-Za-z0-9_.:/-]*)\[([^\]]+)\](?:\{(\d+)(?:,\d*)?\}|(\+)|(\*))?\$$/.exec(pattern);
  if (!m) return undefined;
  const [, prefix, cls, exact, plus] = m;
  const count = exact !== undefined ? Number(exact) : plus ? 1 : 0;
  const ch = cls.startsWith('\\') ? cls[1] : cls[0];
  if (!ch) return undefined;
  const cand = prefix + ch.repeat(count);
  return new RegExp(pattern, 'u').test(cand) ? cand : undefined;
}

function candidates(schema, depth = 0, key = '') {
  if (!schema || typeof schema !== 'object' || depth > 8) return [null];
  if ('const' in schema) return [schema.const];
  if (schema.enum) return schema.enum.slice(0, 3);
  if ('default' in schema && depth > 0) return [undefined, schema.default];
  for (const k of ['anyOf', 'oneOf']) if (schema[k]) return schema[k].flatMap((s) => candidates(s, depth + 1, key)).slice(0, 8);
  if (schema.allOf) return candidates(Object.assign({}, ...schema.allOf), depth + 1, key);
  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== 'null') ?? 'null') : schema.type;
  switch (type) {
    case 'object': {
      const req = schema.required ?? [];
      const props = schema.properties ?? {};
      const base = {};
      for (const k of req) base[k] = candidates(props[k], depth + 1, k)[0];
      const out = [base];
      // A second try per field: its next candidate, for a field whose first one the schema's own checks refuse.
      for (const k of req) for (const alt of candidates(props[k], depth + 1, k).slice(1, 4)) out.push({ ...base, [k]: alt });
      // Also try with every nullable required field set to null (and single-field non-null swaps), for cross-field
      // refinements where one branch requires a group of fields to be null together (e.g. open vs closed stage).
      const nullable = req.filter((k) => candidates(props[k], depth + 1, k).includes(null));
      if (nullable.length >= 2) {
        const nulled = { ...base };
        for (const k of nullable) nulled[k] = null;
        out.push(nulled);
        for (const k of nullable) if (base[k] !== null) out.push({ ...nulled, [k]: base[k] });
      }
      return out;
    }
    case 'array': {
      const item = candidates(schema.items, depth + 1);
      const n = schema.minItems ?? 0;
      return n === 0 ? [[], [item[0]]] : [Array.from({ length: n }, (_, i) => item[i % item.length])];
    }
    case 'string': {
      // A uuid can't say it is a placeholder, so a credential-named one gets no sample: the secret scan would read the
      // literal as a committed credential, and its call stays by name (no accepted input) rather than land one.
      if (schema.format === 'uuid')
        return CREDENTIAL_KEY.test(key) ? [] : ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      if (schema.format === 'date-time') return ['2026-01-01T00:00:00.000Z'];
      if (schema.format === 'date') return ['2026-01-01'];
      if (schema.format === 'email') return ['a@example.com'];
      if (schema.format === 'uri' || schema.format === 'url') return ['https://example.com'];
      const min = schema.minLength ?? 0;
      const max = schema.maxLength ?? Infinity;
      let list = STRINGS.filter((s) => s.length >= min && s.length <= max);
      if (schema.pattern) {
        const re = new RegExp(schema.pattern, 'u');
        const synth = sampleFromPattern(schema.pattern);
        list = [
          ...(synth ? [synth] : []),
          ...STRINGS,
          ...Array.from({ length: 6 }, (_, i) => 'a'.repeat(Math.max(1, min + i))),
          ...Array.from({ length: 6 }, (_, i) => '1'.repeat(Math.max(1, min + i))),
        ].filter((s) => re.test(s) && s.length >= min && s.length <= max);
      }
      if (list.length === 0) list = ['x'.repeat(Math.max(1, min))];
      if (CREDENTIAL_KEY.test(key)) {
        const fake = `placeholder${'x'.repeat(Math.max(0, min - 11))}`;
        const fits = fake.length <= max && (!schema.pattern || new RegExp(schema.pattern, 'u').test(fake));
        if (fits) return [fake];
        // A pattern that cannot carry a self-declaring placeholder (save an EVM address or <=2 chars, which
        // secret-scan.mjs accepts) gets no sample, so a run never writes a credential-shaped literal.
        return list.filter((s) => /^0x[0-9a-f]{40}$/i.test(s) || /^.{1,2}$/.test(s) || /placeholder|sample/i.test(s));
      }
      return list.slice(0, 6);
    }
    case 'integer':
    case 'number': {
      const lo = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
      return [
        ...new Set(
          [lo ?? 1, 1, 0, 10, schema.maximum].filter(
            (v) => v !== undefined && (schema.maximum === undefined || v <= schema.maximum) && (lo === undefined || v >= lo),
          ),
        ),
      ];
    }
    case 'boolean':
      return [true, false];
    case 'null':
      return [null];
    default:
      return [{}, 'x', 1];
  }
}

const REFUSALS = [42, 'not-an-input', [], null, true, { '': 1 }];

/** Values tried where an input check sits: blanks, short and long strings, numbers, absence, and maps of growing size. */
const CHECK_TRIES = [undefined, null, '', ' ', 'x', 'ab', 'x'.repeat(1001), 0, -1, 1, ...STRINGS, [], {}, ...KEY_MAPS];

/** zod's own words for a custom issue: what a `.refine` written with no message raises. */
const QUIET = z
  .unknown()
  .refine(() => false)
  .safeParse(0).error.issues[0].message;

/** `v` with the value at `steps` (`.reason`, `[]`) set to `value`, or undefined when the path is not there. */
function setAt(v, steps, value) {
  if (!steps.length) return value;
  const [step, ...rest] = steps;
  if (step === '[]') {
    if (!Array.isArray(v) || !v.length) return undefined;
    const inner = setAt(v[0], rest, value);
    return inner === undefined && rest.length ? undefined : [inner, ...v.slice(1)];
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  if (rest.length && !(step in v)) return undefined;
  const inner = rest.length ? setAt(v[step], rest, value) : value;
  if (inner === undefined && rest.length) return undefined;
  const out = { ...v };
  if (inner === undefined) delete out[step];
  else out[step] = inner;
  return out;
}

/** `input.items[].reason` after the root as steps: `['items', '[]', 'reason']`. */
const stepsOf = (at) => [...at.replace(/^input/, '').matchAll(/\.([\w$]+)|\[\]/g)].map((m) => m[1] ?? '[]');

/** The value in `v` at `steps`, or undefined when the path is not there. */
function getAt(v, steps) {
  let cur = v;
  for (const step of steps) {
    if (step === '[]') {
      if (!Array.isArray(cur) || !cur.length) return undefined;
      cur = cur[0];
    } else if (typeof cur === 'object' && cur !== null && !Array.isArray(cur) && step in cur) {
      cur = cur[step];
    } else return undefined;
  }
  return cur;
}

/** Optional-property combinations over `base`: singles, same-shape pairs (e.g. `from`/`before`), and all optional set. */
function optionalCombos(json, base) {
  if (!base || typeof base !== 'object' || Array.isArray(base) || json?.type !== 'object' || !json.properties) return [];
  const req = new Set(json.required ?? []);
  const opts = Object.entries(json.properties)
    .filter(([k]) => !req.has(k))
    .map(([k, s]) => ({ k, val: candidates(s, 1, k)[0], tag: `${s?.type ?? ''}:${s?.format ?? ''}` }))
    .filter((o) => o.val !== undefined);
  if (!opts.length) return [];
  const out = opts.map((o) => ({ ...base, [o.k]: o.val }));
  for (let i = 0; i < opts.length; i++)
    for (let j = i + 1; j < opts.length; j++)
      if (opts[i].tag === opts[j].tag) out.push({ ...base, [opts[i].k]: opts[i].val, [opts[j].k]: opts[j].val });
  const all = { ...base };
  for (const o of opts) all[o.k] = o.val;
  out.push(all);
  return out;
}

/** Walks `schema` one step (`prop` or `[]`), stepping into the non-null branch of anyOf/oneOf. */
function schemaStep(schema, step) {
  if (!schema || typeof schema !== 'object') return undefined;
  for (const k of ['anyOf', 'oneOf']) {
    if (!schema[k]) continue;
    for (const s of schema[k]) {
      if (s?.type === 'null') continue;
      const hit = schemaStep(s, step);
      if (hit !== undefined) return hit;
    }
  }
  if (step === '[]') return schema.items;
  return schema.properties?.[step];
}

/** Ensures every parent container along `steps` exists in `v`, filling missing optional/null parents from `schema`. */
function ensurePath(v, schema, steps) {
  if (steps.length <= 1 || !schema) return v;
  const [step, ...rest] = steps;
  if (step === '[]') {
    const itemSchema = schemaStep(schema, '[]');
    const arr = Array.isArray(v) && v.length ? v : itemSchema ? [candidates(itemSchema, 1)[0]] : undefined;
    if (!arr || arr[0] === undefined) return undefined;
    const head = ensurePath(arr[0], itemSchema, rest);
    return head === undefined ? undefined : [head, ...arr.slice(1)];
  }
  const propSchema = schemaStep(schema, step);
  if (!propSchema) return v;
  const obj = typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
  let child = obj[step];
  if (child === undefined || child === null) child = candidates(propSchema, 1, step).find((c) => c !== undefined && c !== null);
  if (child === undefined) return undefined;
  const next = ensurePath(child, propSchema, rest);
  return next === undefined ? undefined : { ...obj, [step]: next };
}

/**
 * For each input check the record names, an input refused by that check alone: every issue zod raises is its own words
 * (a custom issue whose message is one of the check's), so the export, which carries the check only by name, accepts it.
 * Tried from every candidate the schema allows, with the value where the check sits replaced. A check that sits on a
 * `.refine` written with no message (a door's, named by the door: door-refine.mjs) raises zod's own words, and is known
 * by them at the very place the value was tried.
 */
function checkRefusals(record, bases, json) {
  const out = [];
  for (const [name, check] of Object.entries(record.checks ?? {})) {
    const says = new Set(check.says.split('; '));
    const saysWords = [...new Set(check.says.match(/[A-Za-z0-9_.-]{2,}/g) ?? [])];
    const alone = (v, steps) => {
      const quiet = quietRefineAt(record.input, steps);
      const r = record.input.safeParse(v);
      return (
        !r.success && r.error.issues.every((i) => i.code === 'custom' && (says.has(i.message) || (quiet && quietIssue(i, steps, QUIET))))
      );
    };
    let found;
    for (const at of typeof check.at === 'string' ? [check.at] : check.at) {
      const steps = stepsOf(at);
      const tries = steps.length
        ? bases.flatMap((b) => {
            const filled = ensurePath(b, json, steps);
            const target = filled ?? b;
            const cur = getAt(target, steps);
            const dup = Array.isArray(cur) && cur.length > 0 ? [[cur[0], cur[0]]] : [];
            return [...dup, ...saysWords, ...CHECK_TRIES].map((t) => setAt(target, steps, t));
          })
        : [...bases, ...optionalCombos(json, bases[0])];
      found = tries.find((v) => v !== undefined && alone(v, steps));
      if (found !== undefined) break;
    }
    if (found === undefined)
      throw new Error(`${record.name}: no input found that input check ${name} alone refuses; write its samples by hand`);
    out.push(`{ verdict: 'refuse', by: '${name}', input: ${JSON.stringify(found)} }`);
  }
  return out;
}

/**
 * A Rust door's own accepted input for each call: the `valid` request its wire replay sends, when the door let it through.
 * A handler may check its input past the schema (a date range, a slug), so only a request the door itself let through is
 * an accepted sample. Two recordings: svc-academy's one file (`tests/fixtures/wire-replay.golden.json`), read by the
 * operator's answer with the store down, not a 400; svc-agents' directory of parts (`tests/fixtures/
 * wire-replay.golden/*.json`), where some caller's answer to it is past the door's checks: not a 400, 401 or 403; and
 * svc-bank's parts, each with its `bodies`, which send each call six inputs (`bankAccepted`).
 */
export function doorAccepts(crateDir) {
  const dir = join(REPO, crateDir, 'tests/fixtures/wire-replay.golden');
  const out = new Map();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.json'))
      .sort()) {
      const part = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (part.bodies) {
        for (const [path, byInput] of Object.entries(part.answers ?? {})) {
          const valid = bankAccepted(part.inputs?.[path], byInput);
          if (valid !== NONE) out.set(path, valid);
        }
        continue;
      }
      for (const [path, valid] of Object.entries(part.inputs ?? {})) {
        const answers = Object.entries(part.answers ?? {}).filter(([k]) => k.startsWith(`${path} valid `));
        if (answers.some(([, a]) => ![400, 401, 403].includes(a.status))) out.set(path, valid);
      }
    }
    return out;
  }
  const golden = JSON.parse(readFileSync(`${dir}.json`, 'utf8'));
  const operator = 3; // the answers' callers: anon, read, write, operator (record-door.mjs), the last holding every scope
  for (const c of golden.calls) {
    const answer = golden.answers[c.path]?.['store-down valid'];
    const body = answer === undefined ? undefined : golden.bodies[answer[operator]];
    if (body !== undefined && !body.startsWith('400 ')) out.set(c.path, c.valid);
  }
  return out;
}

const NONE = Symbol('none');
/**
 * svc-bank's recording (`crates/svc-bank/tests/wire_replay.rs`): each call is sent absent, null, a wrong type, `{}`, the
 * schema's sample and the sample with every field null (the last two as JSON text in `inputs[path]`), and
 * `answers[path]['<input> <caller>']` is `[status, body]`. The first of the sample, `{}`, absent and the sample with nulls
 * that some caller's answer is past the door's checks (not a 400, 401 or 403), or NONE.
 */
export function bankAccepted(inputs, byInput) {
  const sent = [
    ['sample', inputs?.sample],
    ['empty', '{}'],
    ['absent', undefined],
    ['sample-nulls', inputs?.['sample-nulls']],
  ];
  for (const [name, text] of sent) {
    if (name.startsWith('sample') && typeof text !== 'string') continue;
    const statuses = Object.entries(byInput ?? {})
      .filter(([k]) => k.startsWith(`${name} `))
      .map(([, a]) => a[0]);
    if (statuses.some((st) => ![400, 401, 403].includes(st))) return text === undefined ? undefined : JSON.parse(text);
  }
  return NONE;
}

export function samplesFor(record, doorValid) {
  const input = record.input;
  if (input.def?.type === 'undefined' || input._zod?.def?.type === 'undefined') return "[{ verdict: 'accept' }]";
  const ok = (v) => input.safeParse(v).success;
  let accept;
  let json;
  try {
    json = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' });
  } catch {
    json = {};
  }
  // A door record takes the door's own accepted input, or none: a schema-only guess may be one its handler refuses.
  const tries = doorValid ? [doorValid.get(record.path)].filter((v) => v !== undefined) : [...candidates(json), undefined, {}];
  for (const v of tries) {
    if (ok(v)) {
      accept = v;
      break;
    }
  }
  const refuse = REFUSALS.find((v) => !ok(v));
  if (refuse === undefined) throw new Error(`${record.name}: no refused input among ${JSON.stringify(REFUSALS)}`);
  if (accept === undefined && (doorValid || !ok(undefined)))
    throw new Error(`${record.name}: no accepted input found${doorValid ? ' the door lets through' : ''}; write its samples by hand`);
  const a = accept === undefined ? "{ verdict: 'accept' }" : `{ verdict: 'accept', input: ${JSON.stringify(accept)} }`;
  const byCheck = checkRefusals(record, [...(accept === undefined ? [] : [accept]), ...tries.filter((v) => v !== undefined)], json);
  return `[${[a, `{ verdict: 'refuse', input: ${JSON.stringify(refuse)} }`, ...byCheck].join(', ')}]`;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  const unportableOut = flag('--unportable');
  const door = flag('--door');
  const doorValid = door ? doorAccepts(door) : undefined;
  const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const { procedureJsonSchema } = await import(pathToFileURL(join(REPO, 'packages/contracts/dist/procedure.js')).href);
  const unportable = {};
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const dist = join(REPO, 'packages/contracts/dist', basename(file).replace(/\.ts$/, '.js'));
    const mod = await import(pathToFileURL(dist).href);
    let out = src;
    let n = 0;
    for (const m of src.matchAll(/^export const ([A-Z][A-Z0-9_]*) = defineProcedure\(/gm)) {
      const name = m[1];
      // A record whose schemas JSON Schema can't carry is not one the codemod may write: it goes back to its router.
      try {
        procedureJsonSchema(mod[name]);
      } catch (err) {
        unportable[mod[name].path] = String(err.message).split('\n')[0];
        continue;
      }
      const start = m.index;
      const next = src.indexOf('\nexport const ', start + 1);
      const block = src.slice(start, next === -1 ? undefined : next);
      if (!PLACEHOLDER.test(block)) continue;
      // A record the step can find no accepted (or refused) input for goes back to its router the same way, named.
      let samples;
      try {
        samples = samplesFor(mod[name], doorValid);
      } catch (err) {
        unportable[mod[name].path] = String(err.message).split('\n')[0];
        continue;
      }
      out = out.replace(block, block.replace(PLACEHOLDER, `samples: ${samples}`));
      n++;
    }
    writeFileSync(file, out);
    console.log(`${basename(file)}: ${n} records' samples written`);
  }
  if (unportableOut) writeFileSync(unportableOut, JSON.stringify(unportable, null, 2));
  console.log(`${Object.keys(unportable).length} records can't be exported as written`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
