#!/usr/bin/env node
/**
 * SERVICES MAP. One table of every service, built from the code.
 *
 *   pnpm services:map          write docs/SERVICES.md
 *   pnpm services:map --check  fail if docs/SERVICES.md is stale (CI's check is services-map.test.mjs, run by tooling-tests)
 *
 * Sources: each `services/<name>/README.md` (purpose), `docker-compose.apps.yml` (port, host
 * publishing, profile) and each `src/env.ts` zod schema plus the shared slices in
 * `packages/config/src/env.ts` (required env). The env column is a text scan, not a run of the
 * schema: a field is listed when neither its own text nor a helper it calls (resolved in the same
 * file, to any depth) has `.default()`, `.optional()`, `.nullish()`, `.nullable()`, `.catch()` or `z.undefined()`.
 * Conditional rules (`superRefine`) are not seen, so read `src/env.ts` before relying on it.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = join(ROOT, 'docs', 'SERVICES.md');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Removes block and line comments so words inside them cannot change a verdict. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// `blankAsUnset(` is @intafaced/service-kit's helper: it wraps its schema in `.optional()` in another package.
const OPTIONAL_MARK = /\.(default|optional|nullish|nullable|catch)\(|z\.undefined\(|\bblankAsUnset\(/;

/**
 * Top-level helpers of one env file: `const name = ...` and `function name(...)`, each with its own text.
 * A field written as `NAME: ownerInt` or `NAME: bool(true)` takes its default or optionality from the helper.
 */
export function helpersOf(src) {
  const helpers = new Map();
  const chunks = src.split(/^(?=(?:export\s+)?(?:const|let|function|type|interface|class)\b|import\b)/m);
  for (const chunk of chunks) {
    const m = /^(?:export\s+)?(?:const|let|function)\s+([a-z]\w*)/.exec(chunk);
    // Only a helper that builds a schema counts; a plain parser function that mentions `.default(` does not.
    if (m && m[1] !== 'schema' && /\bz\./.test(chunk)) helpers.set(m[1], chunk);
  }
  return helpers;
}

/** Helpers a file imports from its own folder (`import { x } from './y.js'`), so `NAME: x` resolves through them. */
function importedHelpers(src, rel) {
  const out = new Map();
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/gm)) {
    const file = join(dirname(rel), m[2].replace(/\.js$/, '.ts'));
    if (!existsSync(join(ROOT, file))) continue;
    const theirs = helpersOf(stripComments(read(file)));
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name && theirs.has(name)) out.set(name, theirs.get(name));
    }
  }
  return out;
}

/** True when the expression, or a helper it uses (resolved recursively in the same file), has a default or is optional. */
function hasOptionalMark(expr, helpers, seen = new Set()) {
  if (OPTIONAL_MARK.test(expr)) return true;
  for (const m of expr.matchAll(/(?<![.\w])([a-z]\w*)\b/g)) {
    const name = m[1];
    if (seen.has(name) || !helpers.has(name)) continue;
    seen.add(name);
    if (hasOptionalMark(helpers.get(name), helpers, seen)) return true;
  }
  return false;
}

/**
 * Fields written as `NAME: <expression>` inside a z.object. The expression runs to the next field at
 * the same or shallower indent. Returns [{ name, required }].
 */
export function fieldsOf(body, helpers = new Map()) {
  const lines = body.split('\n');
  const key = /^(\s*)([A-Z][A-Z0-9_]*)\s*:/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = key.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let expr = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const next = key.exec(lines[j]);
      const lead = lines[j].match(/^\s*/)[0].length;
      if (lines[j].trim() && (lead < indent || (next && lead <= indent))) break;
      expr += '\n' + lines[j];
    }
    // `.default('')` with a superRefine is a blank the schema then refuses (MATCHING_OPERATOR_IDS), so it counts as required.
    const blankRefused = /\.default\(''\)/.test(expr) && /\.superRefine\(/.test(expr);
    const optional = !blankRefused && hasOptionalMark(expr, helpers);
    out.push({ name: m[2], required: !optional });
  }
  return out;
}

/** Shared slices exported from packages/config: { schemaName: fields }. */
function sharedSlices() {
  const src = stripComments(read('packages/config/src/env.ts'));
  const helpers = helpersOf(src);
  const slices = new Map();
  const re = /export const (\w+EnvSchema) = z\.object\(\{([\s\S]*?)\n\}\);/g;
  for (const m of src.matchAll(re)) slices.set(m[1], fieldsOf(m[2], helpers));
  // serviceEnvSchema is baseEnvSchema merged with five more slices.
  const compose = /export const serviceEnvSchema = ([\s\S]*?);/.exec(src);
  if (compose) {
    const parts = [...compose[1].matchAll(/\b(\w+EnvSchema)\b/g)].map((x) => x[1]);
    slices.set(
      'serviceEnvSchema',
      parts.flatMap((p) => slices.get(p) ?? []),
    );
  }
  return slices;
}

/** Required env of one service: its own z.object fields plus every merged shared slice. null = no env.ts. */
function requiredEnv(service, slices) {
  const rel = `services/${service}/src/env.ts`;
  if (!existsSync(join(ROOT, rel))) return null;
  const src = stripComments(read(rel));
  const helpers = new Map([...importedHelpers(src, rel), ...helpersOf(src)]);
  const fields = [];
  const unresolved = [];
  for (const m of src.matchAll(/\.merge\(\s*(\w+)\s*\)|^const schema = (\w+)/gm)) {
    const name = m[1] ?? m[2];
    if (slices.has(name)) fields.push(...slices.get(name));
    else if (name.endsWith('EnvSchema')) unresolved.push(name);
  }
  const own = /z\.object\(\{([\s\S]*)\}\)/.exec(src);
  if (own) fields.push(...fieldsOf(own[1], helpers));
  const byName = new Map();
  for (const f of fields) byName.set(f.name, f); // later (service-level) definitions win
  const names = [...byName.values()].filter((f) => f.required).map((f) => f.name);
  return { names: names.sort(), unresolved };
}

/** Per compose service: HTTP port, host publishing, profile. */
function composeServices() {
  const text = read('docker-compose.apps.yml');
  const out = new Map();
  const start = text.indexOf('\nservices:');
  const lines = text.slice(start).split('\n');
  let current = null;
  for (const line of lines) {
    const head = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (head) {
      current = { port: null, published: null, profile: null };
      out.set(head[1], current);
      continue;
    }
    if (!current) continue;
    let m;
    if ((m = /^ {6}HTTP_PORT:\s*'?(\d+)'?/.exec(line))) current.port = m[1];
    else if ((m = /^ {4}ports:\s*\[(.*)\]/.exec(line))) current.published = m[1].replace(/['"\s]/g, '');
    else if ((m = /^ {4}profiles:\s*\[(.*)\]/.exec(line))) current.profile = m[1].replace(/['"\s]/g, '');
  }
  return out;
}

/** First sentence of the README, past the title. A short label lead ("THE BALANCE (§4.2).") takes the next sentence too. */
function purpose(service) {
  const rel = `services/${service}/README.md`;
  if (!existsSync(join(ROOT, rel))) return 'No README.';
  const text0 = read(rel);
  // A title like "# svc-dex — the Protocol Plane's front door" already states the purpose.
  const titled = /^# svc-[\w-]+ [—-] (.+)$/m.exec(text0);
  if (titled) return titled[1].replace(/\|/g, '\\|').trim();
  const paragraphs = text0.split(/\n\s*\n/);
  const para = paragraphs.find((p) => {
    const t = p.trim();
    return t && !/^(#|>|\||---|```|<)/.test(t);
  });
  if (!para) return 'No description in README.';
  const flat = para
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z`(])/);
  let text = sentences[0].trim();
  if (text.length < 40 && sentences[1]) text += ' ' + sentences[1].trim();
  if (text.length > 220) text = text.slice(0, 217).replace(/\s+\S*$/, '') + '...';
  return text.replace(/\|/g, '\\|');
}

/** Rust services: `crates/<svc-*>` with a binary. Each replaced a TypeScript service and runs under the same compose name. */
function rustServices() {
  if (!existsSync(join(ROOT, 'crates'))) return [];
  return readdirSync(join(ROOT, 'crates'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('svc-') && existsSync(join(ROOT, 'crates', d.name, 'src/main.rs')))
    .map((d) => d.name)
    .sort();
}

/** First sentence of a crate's `lib.rs` doc, past its `svc-x:` lead. */
export function rustPurpose(lib) {
  const doc = lib
    .split('\n')
    .filter((l) => l.startsWith('//!'))
    .map((l) => l.replace(/^\/\/!\s?/, ''))
    .join(' ')
    .replace(/^svc-[\w-]+:\s*/, '');
  const first = doc.split(/(?<=\.)\s+(?=[A-Z`(])/)[0]?.trim() ?? '';
  if (!first) return 'No description in `src/lib.rs`.';
  return (first[0].toUpperCase() + first.slice(1)).replace(/\|/g, '\\|');
}

// Three shapes refuse an unset field: `get("X").map_or(Err(`, a blank read as `NaN` (`blank("X").unwrap_or("NaN")`, which no
// integer check passes), and svc-ledger's `blank_int("X", None,` (no default).
const refusedWhenUnset = (src) =>
  [
    ...src.matchAll(/get\("([A-Z0-9_]+)"\)\s*\.map_or\(\s*Err\(/g),
    ...src.matchAll(/blank\(\s*"([A-Z0-9_]+)"\s*\)\s*\.unwrap_or\(\s*"NaN"\s*\)/g),
    ...src.matchAll(/blank_int\(\s*"([A-Z0-9_]+)",\s*None,/g),
  ].map((m) => m[1]);

/**
 * Required env of a Rust service: each field `env.rs` refuses when unset (`get("X").map_or(Err(...`), and each one the
 * kit's env slices it calls by path (`service_kit::env::edge(`) refuse, read from the slice's own body in `kit`
 * (`crates/service-kit/src/env.rs`).
 */
export function rustRequiredEnv(src, kit = '') {
  const slices = new Map(
    kit.split(/\n(?=pub fn )/).flatMap((chunk) => {
      const name = /^pub fn (\w+)\(/.exec(chunk)?.[1];
      return name ? [[name, chunk]] : [];
    }),
  );
  const called = [...src.matchAll(/\bservice_kit::env::(\w+)\(/g)].map((m) => m[1]);
  const fromKit = called.flatMap((name) => refusedWhenUnset(slices.get(name) ?? ''));
  return [...new Set([...refusedWhenUnset(src), ...fromKit])].sort();
}

/** Refuses over an empty tree: a map of nothing must not read as a current map. */
function refuse(why) {
  console.error(`SERVICES MAP FAILED - ${why}. NOTHING WAS MAPPED.`);
  process.exit(1);
}

export function render() {
  if (!existsSync(join(ROOT, 'services')) || !existsSync(join(ROOT, 'docker-compose.apps.yml'))) {
    refuse('services/ or docker-compose.apps.yml is missing');
  }
  const slices = sharedSlices();
  const compose = composeServices();
  const services = readdirSync(join(ROOT, 'services'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('svc-'))
    .map((d) => d.name)
    .sort();
  if (services.length === 0 || compose.size === 0) refuse('0 services or 0 compose services were read');

  const envs = new Map(services.map((s) => [s, requiredEnv(s, slices)]));
  const rows = services.map((s) => {
    const c = compose.get(s);
    const port = c?.port ?? '-';
    let host = 'not in compose';
    if (c) host = c.published ? `published ${c.published}` : 'compose network only';
    if (c?.profile) host += `, profile ${c.profile}`;
    const e = envs.get(s);
    let env = 'see `src/env.ts`';
    if (e) {
      env = e.names.length ? e.names.map((n) => `\`${n}\``).join(', ') : 'none';
      if (e.unresolved.length) env += ` (also see \`src/env.ts\`: ${e.unresolved.join(', ')})`;
    }
    return `| \`${s}\` | ${purpose(s)} | ${port} | ${host} | ${env} |`;
  });
  const rust = rustServices().filter((s) => !services.includes(s));
  for (const s of rust) {
    const c = compose.get(s);
    let host = 'not in compose';
    if (c) host = c.published ? `published ${c.published}` : 'compose network only';
    if (c?.profile) host += `, profile ${c.profile}`;
    const envFile = `crates/${s}/src/env.rs`;
    const kitEnv = 'crates/service-kit/src/env.rs';
    const kit = existsSync(join(ROOT, kitEnv)) ? read(kitEnv) : '';
    const names = existsSync(join(ROOT, envFile)) ? rustRequiredEnv(read(envFile), kit) : null;
    const env = names === null ? 'see `src/env.rs`' : names.length ? names.map((n) => `\`${n}\``).join(', ') : 'none';
    const purposeText = existsSync(join(ROOT, `crates/${s}/src/lib.rs`)) ? rustPurpose(read(`crates/${s}/src/lib.rs`)) : 'No `src/lib.rs`.';
    rows.push(`| \`${s}\` (Rust, \`crates/${s}\`) | ${purposeText} | ${c?.port ?? '-'} | ${host} | ${env} |`);
  }

  const inCompose = services.filter((s) => compose.has(s)).length;
  return [
    '# Services',
    '',
    '> Generated by `node tooling/scripts/services-map.mjs` (`pnpm services:map`). Do not edit by hand: `tooling/scripts/services-map.test.mjs` fails when this file is stale.',
    '',
    `${services.length} directories under \`services/\`, ${inCompose} of them in \`docker-compose.apps.yml\`${rust.length ? `, and ${rust.length} Rust service${rust.length === 1 ? '' : 's'} under \`crates/\`` : ''}. Purpose is the first sentence of the service README (of a Rust crate's \`src/lib.rs\` doc; its required env is each field \`src/env.rs\` refuses when unset). Port and host publishing come from \`docker-compose.apps.yml\`. Required env is read from each \`src/env.ts\` and the shared slices in \`packages/config/src/env.ts\` as fields with no default and not optional; conditional rules are not seen, so read \`src/env.ts\` before relying on it.`,
    '',
    '| Service | Purpose | HTTP port | Host | Required env (no default) |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const next = render();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== next) {
      console.error('docs/SERVICES.md is stale. Run `pnpm services:map` and commit the result.');
      process.exit(1);
    }
    console.log('services map: docs/SERVICES.md is current');
  } else {
    writeFileSync(OUTPUT, next);
    console.log(`wrote docs/SERVICES.md (${next.split('\n').length} lines)`);
  }
}
