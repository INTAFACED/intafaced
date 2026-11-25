#!/usr/bin/env node
// Each record of a Rust door's calls against the door: the record's input, as the tree of zod parts the door's zod engine
// runs (`src/door/schemas.json`, written from the TypeScript router's zod by the crate's record-door script), must be the
// door's own tree for that call; and its kind and access must be its `calls.rs` row. Run after contracts is built.
//
//   node tooling/codemod/call-records/door-check.mjs --door crates/svc-academy --service svc-academy [record file.ts ...]
//
// Prints one line per record that differs and exits 1 when any does; a record the door does not serve is named too.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callsOf } from './door.mjs';
import { doorRefines } from './door-refine.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);

/** The named refines the door knows (`record-door.mjs`'s REFINES), by the source of their function. */
const REFINES = {
  'value=>(value.grantId?1:0)+(value.publicId?1:0)===1': 'grant_or_public_id',
  '(n) => !ACADEMY_BUILTIN_ROLES.includes(n)': 'not_builtin_role',
  "(d) => (d.price === null) === (d.priceAsset === null) && (d.pricing === 'paid' || d.price === null)": 'pricing_holds',
  '(v) => /[1-9]/.test(v)': 'has_nonzero_digit',
  "(i) => (i.kind === 'link') === (i.url !== null)": 'link_has_url',
  '(v) => new Set(v.questions.map((q) => q.id)).size === v.questions.length': 'unique_question_ids',
  "(v) => v.kind === 'survey' || v.questions.every(questionHasKey)": 'graded_has_keys',
  "(v) => v.kind === 'survey' || !v.anonymous": 'only_survey_anonymous',
  "(v) => v.resultsVisibility !== 'after_last_attempt' || v.attemptLimit !== null": 'after_last_needs_limit',
  "(q) => !('choices' in q) || uniqueChoices(q.choices)": 'unique_choice_ids',
  "(q) => q.kind !== 'single' || q.correctChoiceId === null || q.choices.some((c) => c.id === q.correctChoiceId)": 'single_key_is_choice',
  "(q) => q.kind !== 'multi' ||\n    q.correctChoiceIds === null ||\n    (new Set(q.correctChoiceIds).size === q.correctChoiceIds.length &&\n        q.correctChoiceIds.every((id) => q.choices.some((c) => c.id === id)))":
    'multi_keys_are_choices',
  "(q) => q.kind !== 'multi' || !q.partialCredit || q.correctChoiceIds === null || q.points % q.correctChoiceIds.length === 0":
    'partial_credit_splits',
  "(v) => !v.startsWith('-')": 'not_negative',
  "(v) => v.text !== 'off' || v.file !== 'off'": 'text_or_file',
  '(c) => ascending(c.levels)': 'levels_ascend',
  '(t) => new Set(t.topicIds).size === t.topicIds.length': 'unique_topic_ids',
  '(input) => new Set(input.courseSlugs).size === input.courseSlugs.length': 'unique_course_slugs',
  '(s) => s !== ACADEMY_DISCUSSION_GENERAL_TOPIC': 'not_general_topic',
  "(rule) => rule.mode === 'delayed' || rule.delayMinutes === null": 'only_delayed_has_delay',
  'v=>!(v.course&&v.certificate)': 'course_or_certificate',
};
// A refine's source as tsc emits it may differ from tsx's only in spacing, a one-parameter arrow's parentheses
// (`(v) => ...` from prettier, `v => ...` from esbuild), and the semicolon a block body's last statement ends with
// (tsc writes `=== day;\n}`, esbuild `===day}`): compare without any of them.
const squash = (s) =>
  s
    .replace(/\s+/g, '')
    .replace(/^\(([A-Za-z_$][\w$]*)\)=>/, '$1=>')
    .replace(/;}/g, '}');
const REFINE_BY = new Map(Object.entries(REFINES).map(([src, id]) => [squash(src), id]));
/** A door's own names for its refines (its recorder's table, door-refine.mjs), read beside the ones named above. */
export const knowRefines = (names) => {
  for (const [src, id] of names) REFINE_BY.set(squash(src), id);
};

const LENGTH_WHEN = 'val.length !== undefined';

/** One zod check as the door writes it, or a reason it has no door form. */
function checkOf(c) {
  const d = c._zod.def;
  const msg = d.error ? (typeof d.error({}) === 'string' ? d.error({}) : d.error({})?.message) : undefined;
  const out = (k, extra = {}) => ({ k, ...extra, ...(d.abort ? { abort: true } : {}), ...(msg !== undefined ? { msg } : {}) });
  if (d.when && !(['min_length', 'max_length', 'length_equals'].includes(d.check) && d.when.toString().includes(LENGTH_WHEN)))
    return { k: `?when ${d.check}` };
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
      if (d.format === 'url') return out('url');
      if (['guid', 'uuid', 'datetime'].includes(d.format)) return out('format', { format: d.format, src: d.pattern.toString() });
      return { k: `?format ${d.format}` };
    case 'overwrite': {
      const src = d.tx.toString();
      if (src === '(input) => input.trim()') return out('trim');
      if (src === '(input) => input.toLowerCase()') return out('lower');
      return { k: `?overwrite ${src}` };
    }
    case 'greater_than':
      return out('gt', { v: d.value, incl: d.inclusive });
    case 'less_than':
      return out('lt', { v: d.value, incl: d.inclusive });
    case 'number_format':
      return d.format === 'safeint' ? out('int') : { k: `?number ${d.format}` };
    case 'custom':
      return out('refine', { id: REFINE_BY.get(squash(d.fn.toString())) ?? `?${d.fn.toString()}`, ...(d.path ? { path: d.path } : {}) });
    default:
      return { k: `?check ${d.check}` };
  }
}

/** A zod schema as the door's nested tree (a part met again on its own path is `{ again: depth }`). */
export function treeOf(s, path = []) {
  const at = path.indexOf(s);
  if (at >= 0) return { again: path.length - at };
  const here = [...path, s];
  const d = s._zod.def;
  const self = s._zod.traits.has('$ZodCheck') && d.type === 'string' ? [s] : [];
  const checks = [...self, ...(d.checks ?? [])].map(checkOf);
  const node = (o) => (checks.length ? { ...o, checks } : o);
  const sub = (x) => treeOf(x, here);
  switch (d.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'date':
      return node({ t: d.type, ...(d.coerce ? { coerce: true } : {}) });
    case 'unknown':
      return node({ t: 'unknown' });
    case 'enum':
      return node({ t: 'enum', values: s.options });
    case 'literal':
      return node({ t: 'literal', values: d.values });
    case 'object': {
      const t = d.catchall?._zod.def.type;
      const catchall = t === 'never' ? 'strict' : t === 'unknown' ? 'passthrough' : t ? `?${t}` : undefined;
      return node({ t: 'object', shape: Object.entries(d.shape).map(([k, v]) => [k, sub(v)]), ...(catchall ? { catchall } : {}) });
    }
    case 'array':
      return node({ t: 'array', el: sub(d.element) });
    case 'optional':
    case 'nullable':
      return node({ t: d.type, in: sub(d.innerType) });
    case 'default':
      return node({ t: 'default', in: sub(d.innerType), value: d.defaultValue });
    case 'union':
      return d.discriminator !== undefined
        ? node({ t: 'dunion', disc: d.discriminator, options: d.options.map(sub) })
        : node({ t: 'union', options: d.options.map(sub) });
    case 'record':
      return node({ t: 'record', key: sub(d.keyType), value: sub(d.valueType) });
    case 'lazy':
      return node({ t: 'lazy', in: sub(s._zod.innerType) });
    default:
      return { t: `?${d.type}` };
  }
}

/** The door's tree for node `id`, nested the same way. */
export function doorTree(nodes, id, path = []) {
  const at = path.indexOf(id);
  if (at >= 0) return { again: path.length - at };
  const here = [...path, id];
  const n = nodes[id];
  const sub = (x) => doorTree(nodes, x, here);
  const out = { ...n };
  if (n.shape) out.shape = n.shape.map(([k, v]) => [k, sub(v)]);
  if (n.el !== undefined) out.el = sub(n.el);
  if (n.in !== undefined) out.in = sub(n.in);
  if (n.options) out.options = n.options.map(sub);
  if (n.key !== undefined) out.key = sub(n.key);
  if (n.value !== undefined && n.t === 'record') out.value = sub(n.value);
  return out;
}

/** Key order never matters, except an object's shape, which zod walks in order. */
export const canon = (v) =>
  Array.isArray(v)
    ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/**
 * The records to hold: with files given (run.mjs passes the ones it wrote), each record those files export, read from the
 * files themselves, so a record written this run is held before the registry is written again; else every registered one.
 */
export function recordsToHold(registry, modules) {
  if (!modules.length) return Object.values(registry);
  const out = new Map();
  for (const mod of modules)
    for (const v of Object.values(mod)) if (v && typeof v === 'object' && typeof v.name === 'string' && v.transport) out.set(v.name, v);
  return [...out.values()];
}

function args(argv) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--door') out.door = argv[++i];
    else if (argv[i] === '--service') out.service = argv[++i];
    else if (argv[i].startsWith('--')) throw new Error(`unknown argument ${argv[i]}`);
    else out.files.push(argv[i]);
  }
  if (!out.door || !out.service) throw new Error('--door and --service are required');
  return out;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const crate = join(REPO, opts.door);
  knowRefines(doorRefines(opts.door));
  const { nodes, inputs } = JSON.parse(readFileSync(join(crate, 'src/door/schemas.json'), 'utf8'));
  const rows = new Map();
  const row = (path, module) => {
    if (!rows.has(module)) rows.set(module, callsOf(crate, module));
    return rows.get(module).get(path);
  };
  const reg = await import(pathToFileURL(join(REPO, 'packages/contracts/dist/procedure-registry.js')).href);
  const bad = [];
  let held = 0;
  const modules = [];
  for (const f of opts.files)
    modules.push(await import(pathToFileURL(join(REPO, 'packages/contracts/dist', basename(f).replace(/\.ts$/, '.js'))).href));
  for (const r of recordsToHold(reg.CONTRACT_PROCEDURES, modules)) {
    if (r.service !== opts.service || r.transport !== 'trpc') continue;
    const door = row(r.path, r.module);
    if (!door) {
      bad.push(`${r.name}: the door serves no ${r.path}`);
      continue;
    }
    const access = door.access ? canon(door.access) : door.why;
    if (door.kind !== r.kind || access !== canon(r.access)) {
      bad.push(`${r.name}: the door serves a ${door.kind} to ${access}, the record names a ${r.kind} to ${canon(r.access)}`);
      continue;
    }
    const none = r.input._zod.def.type === 'undefined';
    const want = inputs[r.path] === undefined ? null : canon(doorTree(nodes, inputs[r.path]));
    const got = none ? null : canon(treeOf(r.input));
    if (want !== got) bad.push(`${r.name}: input\n  door   ${want}\n  record ${got}`);
    else held++;
  }
  console.log(`${held} records held to ${opts.door}; ${bad.length} differ`);
  for (const b of bad) console.log(b);
  if (bad.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
