#!/usr/bin/env node
/**
 * BOUNDARY AND MONEY-FENCE SCAN.
 *
 * Two fences, both green on main today, so a break is a new break:
 *
 * BOUNDARY (services never reach into each other)
 *   B-deps    no `@intafaced/svc-*` dependency from an app or package, or from one service to another.
 *   B-hops    no non-test source file imports a path that climbs into another service or an app
 *             (`../../svc-x/...`, `services/svc-x/...` inside an import specifier).
 *   B-sql     no non-test service or package source runs SQL against another service's schema (`FROM trade.orders` in
 *             svc-pay). Any string or template is read, so `sql<T>`, `tx`, `.unsafe(...)` and plain strings are all seen.
 *   B-reads   no non-test package reads another service's source from disk (`readFileSync(join(ROOT, 'services', ...))`),
 *             and no service reads another service's directory.
 *   B-cycle   no dependency cycle between workspace packages (`dependencies`, `devDependencies`, `peerDependencies`).
 *
 * MONEY FENCE (one custodial ledger, business-key idempotency)
 *   M-entries no ledger entry (`direction: 'debit'|'credit'`) built in non-test code outside packages/ledger-client and
 *             services/svc-ledger, whether in a literal, pushed onto an array or spread.
 *   M-balance no service migration or drizzle schema creates a balance, available, held, locked, reserved, used or
 *             refunded column (also via ADD COLUMN), or `margin_current`, outside svc-ledger. Counters and mirrors that
 *             exist today are allowlisted by name with a reason.
 *   M-client  outside packages/ledger-client and services/svc-ledger, no `implements LedgerClient`, no object-literal or
 *             cast `LedgerClient`, no factory returning `LedgerClient` that does not use the shared client, and no
 *             `/trpc/post` path literal in a file that does not use the shared client.
 *   M-key     no `randomUUID()`, `Date.now()` or `Math.random()` inside an `idempotencyKey` expression, including one
 *             that spans lines or goes through a local variable, in service or ledger-client code.
 *
 * DUPLICATE RATCHET (counts only shrink; baseline in tooling/ci/duplicate-ratchet.json, rewrite with --write-baseline)
 *   R-scale   local `10n ** 18n` scale constants outside packages/ledger-client (use its money.ts).
 *   R-unwrap  hand-rolled tRPC reply unwraps (`result?.data`) in services (use contracts `unwrapTrpcData`).
 *   R-parse   hand-rolled decimal parsers (`.padEnd(n, '0')`) outside packages/ledger-client.
 *   R-fetch   service files that call `fetch(` and never set a timeout or signal.
 *
 * Known limits (a regex scan, not a parser): a SQL string built by concatenation, a second table after a comma in FROM,
 * a key made by destructuring, a default parameter, a reassigned variable or a function other than randomUUID, Date.now and
 * Math.random, an arrow-function LedgerClient factory, and a file path held in a variable are not seen. The Sonnet and
 * Opus reviews on each PR are the second line for those.
 *
 * Known exceptions live in `tooling/ci/boundary-allow.json`, each with a written reason. An entry that no longer
 * matches anything warns with the line to delete (a fix never fails the build; owner decision 2026-10-27).
 *
 *   node tooling/ci/boundary-scan.mjs
 *   node tooling/ci/boundary-scan.mjs --self-test
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const GROUPS = ['apps', 'services', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'build',
  'target',
  '.git',
  'drizzle',
  'testing',
  'tests',
  'vendored',
]);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:test|spec|fixture)\.(?:[cm]?[jt]sx?)$/;
export const ALLOW_FILE = 'tooling/ci/boundary-allow.json';
export const RATCHET_FILE = 'tooling/ci/duplicate-ratchet.json';

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (SOURCE.test(e.name) && !TEST.test(e.name)) yield p;
  }
}

/** Schema names that belong to services: `mining_pool`, `trade`, … read from the dev bootstrap. */
export function loadSchemas(root = ROOT) {
  const f = join(root, 'tooling/infra/postgres-init/01-service-schemas.sql');
  if (!existsSync(f)) return [];
  const text = readFileSync(f, 'utf8');
  const block = text.match(/services text\[\] := ARRAY\[([\s\S]*?)\];/);
  return block ? [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
}

export function schemaOf(serviceDir) {
  return serviceDir.replace(/^svc-/, '').replace(/-/g, '_');
}

/**
 * The expression after `idempotencyKey` (`: expr`, `= expr`), across lines, up to the `,` `;` or closing bracket that ends
 * it. Returns '' for a shorthand property (`{ idempotencyKey }`) and null when the word is not a key being set.
 */
export function keyExpression(code, from) {
  let i = from;
  while (/\s/.test(code[i] ?? '')) i += 1;
  if (code[i] === ',' || code[i] === '}') return '';
  if (code[i] !== ':' && code[i] !== '=') return null;
  if (code[i] === '=' && (code[i + 1] === '=' || code[i + 1] === '>')) return null;
  i += 1;
  const start = i;
  let depth = 0;
  const end = Math.min(code.length, start + 2000);
  for (; i < end; i += 1) {
    const c = code[i];
    if (c === '`') {
      for (i += 1; i < code.length && code[i] !== '`'; i += 1) if (code[i] === '\\') i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      for (i += 1; i < code.length && code[i] !== c; i += 1) if (code[i] === '\\') i += 1;
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if ((c === ',' || c === ';') && depth === 0) break;
  }
  return code.slice(start, i);
}

/** Findings for one source text. `ctx` = { rel, group, service } where service is `svc-x` for services/svc-x files. */
export function checkSource(text, ctx, schemas) {
  const code = stripComments(text);
  const out = [];
  const add = (rule, detail) => {
    if (!out.some((o) => o.rule === rule && o.detail === detail)) out.push({ rule, file: ctx.rel, detail });
  };

  for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)(['"])([^'"]+)\1/g)) {
    const spec = m[2];
    const hop = spec.match(/(?:^|\/)services\/(svc-[a-z0-9-]+)\//) ?? spec.match(/^(?:\.\.\/)+(svc-[a-z0-9-]+)\//);
    if (hop && hop[1] !== ctx.service) add('B-hops', `imports ${spec}`);
    if (/(?:^|\/)apps\/[a-z0-9-]+\//.test(spec) && ctx.group !== 'apps') add('B-hops', `imports ${spec}`);
  }

  if (ctx.group === 'services' || ctx.group === 'packages') {
    const own = ctx.service ? schemaOf(ctx.service) : null;
    // Read the whole text, not only sql`...`: generic tags (sql<T>`...`), tx`...`, .unsafe('...') and plain strings all count.
    // After FROM or JOIN a trailing `(` is a function call (prose like `ledger.balance(x)`); after INTO, UPDATE or
    // TRUNCATE it is a column list (`INSERT INTO trade.orders(id)`), so only the first pair excludes it.
    const TABLE =
      /\b(?:FROM|JOIN)\s+"?([a-z_]+)"?\."?[a-z_]+"?(?![a-z_"(])|\b(?:INTO|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+"?([a-z_]+)"?\."?[a-z_]+"?(?![a-z_"])/gi;
    for (const q of code.matchAll(TABLE)) {
      const schema = (q[1] ?? q[2]).toLowerCase();
      if (schema !== own && schemas.includes(schema)) add('B-sql', `queries ${schema}.* from ${ctx.service ?? ctx.rel}`);
    }
    // A package or service reading another service's files from disk (honesty checks, doc scrapers) is a hidden dependency.
    for (const m of code.matchAll(/\b(?:readFileSync|readFile|existsSync|readdirSync|readdir|statSync)\s*\(([^)\n]*)/g)) {
      const arg = m[1];
      const other = [...arg.matchAll(/\bsvc-[a-z0-9-]+/g)].find((x) => x[0] !== ctx.service);
      if ((ctx.group === 'packages' && /['"`/]services['"`/]/.test(arg)) || other)
        add('B-reads', `reads ${other ? other[0] : 'services/'} from disk`);
    }
  }

  const ledgerOwner = ctx.rel.startsWith('packages/ledger-client/') || ctx.rel.startsWith('services/svc-ledger/');
  const sharedClient = /\b(?:createHttpLedgerClient|createLedgerTransport)\b/.test(code);
  if (!ledgerOwner && ctx.group !== 'apps') {
    // A ledger entry carries `direction: 'debit'|'credit'`. A type union (`direction: 'debit' | 'credit'`) is not a value.
    if (/\bentries\s*:\s*\[[^\]]{0,300}?\bdirection\s*:/.test(code) || /\bdirection\s*:\s*['"`](?:debit|credit)['"`](?!\s*\|)/.test(code))
      add('M-entries', 'builds a ledger entry (direction debit/credit) inline');
  }
  if (!ledgerOwner) {
    if (/\bimplements\s+(?:[\w.]+\s*,\s*)*LedgerClient\b/.test(code))
      add('M-client', 'implements LedgerClient outside the ledger packages');
    if (/:\s*LedgerClient\s*=\s*\{|\bas\s+LedgerClient\b|\bsatisfies\s+LedgerClient\b|<LedgerClient>\s*\{/.test(code))
      add('M-client', 'builds a LedgerClient object by hand');
    if (/\)\s*:\s*LedgerClient\s*\{/.test(code) && !sharedClient) add('M-client', 'returns a LedgerClient without the shared client');
    if (/\/trpc\/post\b/.test(code) && !sharedClient) add('M-client', 'posts to the ledger path directly');
  }

  if (ctx.group === 'services' || ctx.rel.startsWith('packages/ledger-client/')) {
    // A local assigned from a random or clock value is just as unstable as an inline call. Only the nearest earlier
    // declaration of the name counts, within 4000 characters, so an unrelated variable of the same name elsewhere is not hit.
    const RANDOM = /\brandomUUID\s*\(|\bDate\.now\s*\(|\bMath\.random\s*\(/;
    const decls = [...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;\n]*)/g)].map((d) => ({
      name: d[1],
      at: d.index,
      random: RANDOM.test(d[2]),
    }));
    const byName = new Map();
    for (const d of decls) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
    const taintedAt = (name, at) => {
      const list = byName.get(name) ?? [];
      let last;
      for (let k = list.length - 1; k >= 0; k -= 1) {
        if (list[k].at < at) {
          last = list[k];
          break;
        }
      }
      return Boolean(last && last.random && at - last.at < 4000);
    };
    for (const m of code.matchAll(/\bidempotencyKey\b/g)) {
      const expr = keyExpression(code, m.index + m[0].length);
      if (expr === null) continue;
      const names = expr === '' ? ['idempotencyKey'] : [...expr.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
      if (RANDOM.test(expr) || names.some((n) => taintedAt(n, m.index)))
        add('M-key', 'idempotency key built from randomUUID/Date.now/Math.random');
    }
  }
  return out;
}

/** Column names that look like a service keeping its own money: balance, available, held, locked, reserved, used, refunded. */
const MONEY_NAME =
  '[a-z_]*(?:balance|available)[a-z_]*|(?:[a-z_]*_)?(?:held|locked|reserved|used|refunded)(?:_[a-z_]*)?|hold_amount|margin_current';
const MONEY_NOT = /_(?:count|at|id|seq|bps|ratio|pct)$/;
const COLUMN_TYPE =
  '(?:numeric|bigint|integer|int|int4|int8|smallint|decimal|money|real|float4|float8|double\\s+precision|varchar|text)\\b';
// `"name" numeric(...)` at the start of a line, or `ADD COLUMN [IF NOT EXISTS] name numeric` anywhere.
const BALANCE_COLUMN = new RegExp(`(?:^\\s*|\\bADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)"?(${MONEY_NAME})"?\\s+${COLUMN_TYPE}`, 'i');
// drizzle: numeric('balance', ...) / bigint("held", ...)
const SCHEMA_COLUMN = new RegExp(
  '\\b(?:numeric|bigint|integer|decimal|text|real|varchar|smallint|doublePrecision)\\(\\s*[\'"`](' + MONEY_NAME + ')[\'"`]',
  'gi',
);

export function checkMigration(text, ctx) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(BALANCE_COLUMN);
    if (m && !MONEY_NOT.test(m[1].toLowerCase())) out.push({ rule: 'M-balance', file: ctx.rel, detail: `column ${m[1].toLowerCase()}` });
  }
  return out;
}

/** The same check over a drizzle table definition (`src/db/schema.ts`). */
export function checkSchemaTs(text, ctx) {
  const out = [];
  for (const m of stripComments(text).matchAll(SCHEMA_COLUMN)) {
    if (!MONEY_NOT.test(m[1].toLowerCase())) out.push({ rule: 'M-balance', file: ctx.rel, detail: `column ${m[1].toLowerCase()}` });
  }
  return out;
}

/** Dependency cycles between workspace packages (an edge for every kind of dependency, as turbo sees them). */
export function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const d of graph.get(n) ?? []) {
      if (!graph.has(d)) continue;
      if (state.get(d) === 1) cycles.push([...stack.slice(stack.indexOf(d)), d]);
      else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of graph.keys()) if (!state.has(n)) visit(n);
  return cycles;
}

function workspaceCycles(root) {
  const graph = new Map();
  for (const group of GROUPS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const pj = join(base, d, 'package.json');
      if (!existsSync(pj)) continue;
      const json = JSON.parse(readFileSync(pj, 'utf8'));
      const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => Object.keys(json[k] ?? {}));
      graph.set(
        json.name,
        deps.filter((n) => n.startsWith('@intafaced/')),
      );
    }
  }
  return findCycles(graph).map((c) => ({ rule: 'B-cycle', file: 'package.json', detail: c.join(' -> ') }));
}

function packageDeps(root) {
  const out = [];
  for (const group of GROUPS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const pj = join(base, d, 'package.json');
      if (!existsSync(pj)) continue;
      const json = JSON.parse(readFileSync(pj, 'utf8'));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const n of Object.keys(json[k] ?? {})) {
          if (/^@intafaced\/svc-/.test(n)) out.push({ rule: 'B-deps', file: `${group}/${d}/package.json`, detail: `${k} ${n}` });
        }
      }
    }
  }
  return out;
}

export function scan(root = ROOT) {
  const schemas = loadSchemas(root);
  const findings = [...packageDeps(root), ...workspaceCycles(root)];
  const duplicates = {};
  let files = 0;
  for (const group of GROUPS) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const dir = join(base, d);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const service = group === 'services' ? d : null;
      for (const f of walk(dir)) {
        files += 1;
        const rel = f
          .slice(root.length + 1)
          .split('\\')
          .join('/');
        const text = readFileSync(f, 'utf8');
        findings.push(...checkSource(text, { rel, group, service }, schemas));
        if (group !== 'apps') {
          const c = countDuplicates(text, rel);
          if (KINDS.some((k) => c[k] > 0)) duplicates[rel] = Object.fromEntries(KINDS.filter((k) => c[k] > 0).map((k) => [k, c[k]]));
        }
        if (group === 'services' && d !== 'svc-ledger' && rel.endsWith('/src/db/schema.ts')) findings.push(...checkSchemaTs(text, { rel }));
      }
      const drizzle = join(dir, 'drizzle');
      if (group === 'services' && d !== 'svc-ledger' && existsSync(drizzle)) {
        for (const m of readdirSync(drizzle)) {
          if (!m.endsWith('.sql') || m.endsWith('.down.sql')) continue;
          findings.push(...checkMigration(readFileSync(join(drizzle, m), 'utf8'), { rel: `${group}/${d}/drizzle/${m}` }));
        }
      }
    }
  }
  return { findings, files, schemas: schemas.length, duplicates };
}

/** Duplicate counts in one source text (comment lines are not counted). `rel` decides which kinds apply. */
export function countDuplicates(text, rel) {
  const out = { scale: 0, unwrap: 0, parse: 0, fetch: 0 };
  const code = stripComments(text);
  const inLedgerClient = rel.startsWith('packages/ledger-client/');
  const count = (re) => (code.match(re) ?? []).length;
  if (!inLedgerClient) {
    out.scale = count(/\b10n\s*\*\*\s*18n\b/g);
    out.parse = count(/\.padEnd\(\s*[\w.]+\s*,\s*['"]0['"]\s*\)/g);
  }
  if (rel.startsWith('services/')) {
    out.unwrap = count(/\bresult\??\.data\b/g);
    if (!/AbortSignal|timeoutMs|\bsignal\s*[:,}]|timeout/i.test(code)) out.fetch = count(/(?<![.\w])(?:globalThis\.)?fetch\(/g);
  }
  return out;
}

const KINDS = ['scale', 'unwrap', 'parse', 'fetch'];
const KIND_RULE = { scale: 'R-scale', unwrap: 'R-unwrap', parse: 'R-parse', fetch: 'R-fetch' };

/** Compares counts to the baseline: a rise or a new file fails; a fall passes, so lowering the baseline is optional. */
export function compareRatchet(files, baseline) {
  const problems = [];
  const seen = new Set([...Object.keys(files), ...Object.keys(baseline)]);
  for (const f of [...seen].sort()) {
    for (const k of KINDS) {
      const now = files[f]?.[k] ?? 0;
      const was = baseline[f]?.[k] ?? 0;
      if (now > was)
        problems.push({ rule: KIND_RULE[k], file: f, detail: `${now} (baseline ${was}): new duplicate, use the canonical module` });
    }
  }
  return problems;
}

const key = (f) => `${f.rule} ${f.file} ${f.detail}`;

/** Splits findings into the ones the allowlist covers and the ones it does not, and lists allow entries that matched nothing. */
export function applyAllow(findings, allow) {
  const used = new Set();
  const open = [];
  for (const f of findings) {
    const i = allow.findIndex((a) => a.rule === f.rule && a.file === f.file && (a.detail === undefined || f.detail.includes(a.detail)));
    if (i >= 0) used.add(i);
    else open.push(f);
  }
  return { open, stale: allow.filter((_, i) => !used.has(i)) };
}

function selfTest() {
  const schemas = ['trade', 'pay', 'mining_pool'];
  const t = (text, ctx) =>
    checkSource(text, { rel: 'services/svc-pay/src/x.ts', group: 'services', service: 'svc-pay', ...ctx }, schemas).map((f) => f.rule);
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)}`);
  };
  eq(t("import x from '../../svc-trade/src/a.js';"), ['B-hops'], 'sibling hop');
  eq(t("import x from '../helpers.js';"), [], 'plain import');
  eq(t("// import x from '../../svc-trade/a.js'"), [], 'comment ignored');
  eq(t('await sql`SELECT * FROM trade.orders`'), ['B-sql'], 'other schema');
  eq(t('await sql`SELECT * FROM pay.orders`'), [], 'own schema');
  eq(t("const r = { entries: [{ account: a, direction: 'debit', amount: 1n }] };"), ['M-entries'], 'inline entries');
  eq(t('const a = { entries: [] };'), [], 'audit entries are not postings');
  eq(
    t("const r = { entries: [{ account: a, direction: 'debit' }] };", {
      rel: 'packages/ledger-client/src/r.ts',
      group: 'packages',
      service: null,
    }),
    [],
    'ledger-client owns entries',
  );
  eq(t('export class MyLedger implements LedgerClient {}'), ['M-client'], 'own ledger client');
  eq(t("await fetch(`${base}/trpc/post`, { method: 'POST' });"), ['M-client'], 'direct ledger post');
  eq(t('const c = createHttpLedgerClient({ baseUrl });'), [], 'shared client');
  eq(
    t('class L implements LedgerClient {}', { rel: 'services/svc-ledger/src/s.ts', service: 'svc-ledger' }),
    [],
    'ledger service owns the interface',
  );
  eq(t('post({ idempotencyKey: `x:${randomUUID()}` })'), ['M-key'], 'random key');
  eq(t('post({ idempotencyKey: `x:${order.id}` })'), [], 'business key');
  eq(
    checkMigration('  hold_amount numeric(38,18) NOT NULL,', { rel: 'm.sql' }).map((f) => f.rule),
    ['M-balance'],
    'balance column',
  );
  eq(checkMigration('  filled_at timestamptz,', { rel: 'm.sql' }), [], 'plain column');
  // The six evasions an independent reviewer fed the first version of this gate (briefs-scope-audit 2026-10-20 section 5).
  eq(t('await sql<{ a: string }[]>`SELECT * FROM trade.orders`'), ['B-sql'], 'evasion 1: generic sql tag');
  eq(t('await tx`SELECT * FROM trade.orders`'), ['B-sql'], 'evasion 1: tx tag');
  eq(t('await tx<Row[]>`SELECT * FROM "trade"."orders"`'), ['B-sql'], 'evasion 1: tx generic quoted');
  eq(t('await sql.unsafe("SELECT * FROM trade.orders")'), ['B-sql'], 'evasion 1: unsafe string');
  eq(t('const msg = "amounts come from ledger.balance(houseFees)"'), [], 'a function call is not a table');
  eq(
    checkMigration('  ADD COLUMN IF NOT EXISTS "available" numeric(38, 18) NOT NULL DEFAULT 0;', { rel: 'm.sql' }).map((x) => x.rule),
    ['M-balance'],
    'evasion 2: ADD COLUMN available',
  );
  eq(checkMigration('ALTER TABLE x ADD COLUMN margin_current numeric;', { rel: 'm.sql' }).length, 1, 'ADD COLUMN margin mirror');
  eq(checkMigration('  "refunded_count" integer NOT NULL DEFAULT 0,', { rel: 'm.sql' }), [], 'a count is not a balance');
  eq(
    checkSchemaTs("export const t = pgTable('t', { held: numeric('held', { precision: 38 }) });", { rel: 's.ts' }).length,
    1,
    'drizzle schema column',
  );
  eq(t('const k = randomUUID();\nawait post({ idempotencyKey: k });'), ['M-key'], 'evasion 3: key from a variable');
  eq(t('const k = `x:${Date.now()}`;\nawait post({ idempotencyKey: `pay:${k}` });'), ['M-key'], 'evasion 3: key from a clock variable');
  eq(t('await post({\n  idempotencyKey:\n    `x:${randomUUID()}`,\n});'), ['M-key'], 'evasion 3: key on the next line');
  eq(t('const id = randomUUID();\nfoo(id);\nawait post({ idempotencyKey: `x:${row.id}` });'), [], 'property named like a random local');
  eq(t('const idempotencyKey = randomUUID();\nawait post({ idempotencyKey });'), ['M-key'], 'evasion 3: shorthand key');
  eq(
    t("const e = [];\ne.push({ account: a, direction: 'debit', amount: 1n });\nawait post({ entries: e });"),
    ['M-entries'],
    'evasion 4: entries pushed',
  );
  eq(t("type Row = { direction: 'debit' | 'credit' };"), [], 'a direction type union is not an entry');
  eq(t('const c: LedgerClient = { post, balance };'), ['M-client'], 'evasion 5: object-literal client');
  eq(t('const c = makeThing() as LedgerClient;'), ['M-client'], 'cast client');
  eq(t('export function build(): LedgerClient { return { post, balance }; }'), ['M-client'], 'factory without the shared client');
  eq(t('export function build(): LedgerClient { return createHttpLedgerClient({}); }'), [], 'factory over the shared client');
  eq(t('const p = "/trpc/post"; await fetch(base + p);'), ['M-client'], 'ledger path in a variable');
  eq(
    t("const root = join(ROOT, 'services', 'svc-x', 'src', 'a.ts'); readFileSync(root);"),
    [],
    'a variable path is not seen (known limit, documented in the header)',
  );
  eq(
    t("readFileSync(join(ROOT, 'services', 'svc-execution', 'src', 'a.ts'), 'utf8')", {
      rel: 'packages/p/src/a.ts',
      group: 'packages',
      service: null,
    }),
    ['B-reads'],
    'package reads a service from disk',
  );
  eq(t("readFileSync(join(__dirname, '..', 'svc-trade', 'a.ts'))"), ['B-reads'], 'service reads a sibling service from disk');
  eq(t("readFileSync(join(__dirname, 'svc-pay.txt'))"), [], 'own name is fine');
  // evasion 6 (a local scale constant) is the ratchet: it may not grow.
  eq(Object.values(countDuplicates('const SCALE = 10n ** 18n; a * b / SCALE', 'services/svc-x/src/a.ts')), [1, 0, 0, 0], 'scale counted');
  eq(countDuplicates('const SCALE = 10n ** 18n;', 'packages/ledger-client/src/money.ts').scale, 0, 'ledger-client owns the scale');
  eq(countDuplicates('const x = r.result?.data; const y = result.data;', 'services/svc-x/src/a.ts').unwrap, 2, 'unwraps counted');
  eq(countDuplicates("s.padEnd(18, '0')", 'services/svc-x/src/a.ts').parse, 1, 'padEnd parser counted');
  eq(countDuplicates('await fetch(url);', 'services/svc-x/src/a.ts').fetch, 1, 'fetch without timeout');
  eq(countDuplicates('await fetch(url, { signal: AbortSignal.timeout(5000) });', 'services/svc-x/src/a.ts').fetch, 0, 'fetch with timeout');
  eq(compareRatchet({ a: { scale: 2 } }, { a: { scale: 1 } }).length, 1, 'ratchet rises fail');
  eq(compareRatchet({ a: { scale: 1 } }, { a: { scale: 2 } }), [], 'ratchet falls pass without a baseline edit');
  eq(compareRatchet({ b: { fetch: 1 } }, {}).length, 1, 'new file fails');
  eq(compareRatchet({ a: { scale: 1 } }, { a: { scale: 1 } }), [], 'ratchet holds');
  eq(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ]),
    ).length,
    1,
    'cycle found',
  );
  eq(
    findCycles(
      new Map([
        ['a', ['b']],
        ['b', []],
      ]),
    ).length,
    0,
    'no cycle',
  );
  eq(
    findCycles(
      new Map([
        ['a', ['b', 'c']],
        ['b', ['c']],
        ['c', []],
      ]),
    ).length,
    0,
    'diamond is not a cycle',
  );
  // Second review round: forms the first version of this round lost or never saw.
  eq(t('await sql`INSERT INTO trade.orders(id, amount) VALUES (1, 2)`'), ['B-sql'], 'INSERT INTO with no space before the column list');
  eq(t('await sql`TRUNCATE trade.orders`'), ['B-sql'], 'TRUNCATE other schema');
  eq(t('post({ entries:[{ account: a, direction: row.dir, amount }] });'), ['M-entries'], 'entries with a variable direction');
  eq(
    t("const DEBIT = 'debit';\npost({ entries: [{ account: a, direction: DEBIT }] });"),
    ['M-entries'],
    'entries with a constant direction',
  );
  eq(checkMigration('  balances numeric(38,18),', { rel: 'm.sql' }).length, 1, 'plural balance column');
  eq(checkMigration('  availablebalance numeric,', { rel: 'm.sql' }).length, 1, 'run-together balance column');
  eq(checkMigration('  available int8 NOT NULL,', { rel: 'm.sql' }).length, 1, 'int8 available column');
  const big = 'idempotencyKey: '.repeat(20000);
  const t0 = Date.now();
  t(big);
  if (Date.now() - t0 > 3000) throw new Error('an unterminated key expression made the scan slow');
  const f = { rule: 'B-deps', file: 'a/package.json', detail: 'devDependencies @intafaced/svc-x' };
  eq(applyAllow([f], [{ rule: 'B-deps', file: 'a/package.json', reason: 'r' }]).open, [], 'allowed');
  eq(applyAllow([], [{ rule: 'B-deps', file: 'a/package.json', reason: 'r' }]).stale.length, 1, 'stale allow entry');
  console.log('✓ boundary-scan --self-test OK (self-test fixtures)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  const { findings, files, schemas, duplicates } = scan();
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(
      join(ROOT, RATCHET_FILE),
      JSON.stringify({ files: Object.fromEntries(Object.entries(duplicates).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + '\n',
    );
    console.log(`wrote ${RATCHET_FILE}: ${Object.keys(duplicates).length} file(s)`);
    process.exit(0);
  }
  if (files === 0 || schemas === 0) {
    console.error(
      `\n✖ BOUNDARY SCAN FAILED — scope is EMPTY (${files} source file(s), ${schemas} service schema(s)). A scan of nothing is not a pass.\n`,
    );
    process.exit(1);
  }
  const allow = existsSync(join(ROOT, ALLOW_FILE)) ? JSON.parse(readFileSync(join(ROOT, ALLOW_FILE), 'utf8')).allow : [];
  const baseline = existsSync(join(ROOT, RATCHET_FILE)) ? JSON.parse(readFileSync(join(ROOT, RATCHET_FILE), 'utf8')).files : {};
  const { open: openFindings, stale } = applyAllow(findings, allow);
  const open = [...openFindings, ...compareRatchet(duplicates, baseline)];
  // A stale allow entry is a fix nobody recorded: it warns, naming the line to delete (owner decision 2026-10-27).
  for (const a of stale) {
    const msg = `stale in ${ALLOW_FILE}: [${a.rule}] ${a.file} matches nothing; delete it.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning title=Boundary scan::${msg}` : `  ! ${msg}`);
  }
  if (open.length) {
    console.error(`\n✖ BOUNDARY SCAN FAILED — ${open.length} violation(s)\n`);
    for (const f of open) console.error(`  [${f.rule}] ${f.file}\n    → ${f.detail}\n`);
    process.exit(1);
  }
  console.log(
    `✓ boundary-scan clean — ${files} source file(s), ${schemas} service schema(s), ${allow.length} allowed exception(s), ${Object.keys(baseline).length} file(s) in the duplicate ratchet`,
  );
}
