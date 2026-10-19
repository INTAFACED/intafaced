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
 *   B-sql     no non-test service source runs SQL against another service's schema (`FROM trade.orders` in svc-pay).
 *
 * MONEY FENCE (one custodial ledger, business-key idempotency)
 *   M-entries no `entries: [` literal in non-test code outside packages/ledger-client and services/svc-ledger.
 *   M-balance no service migration creates a balance, available or held column outside svc-ledger. Immutable order
 *             state svc-trade already holds is allowlisted by name.
 *   M-client  outside packages/ledger-client and services/svc-ledger, no `implements LedgerClient` and no `fetch` of
 *             `/trpc/post`: the ledger is posted to only through the shared client from `createHttpLedgerClient`.
 *   M-key     no `randomUUID()` or `Date.now()` inside an `idempotencyKey` expression in service or ledger-client code.
 *
 * Known exceptions live in `tooling/ci/boundary-allow.json`, each with a written reason. An entry that no longer
 * matches anything fails, so the list can only shrink.
 *
 *   node tooling/ci/boundary-scan.mjs
 *   node tooling/ci/boundary-scan.mjs --self-test
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
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

/** Findings for one source text. `ctx` = { rel, group, service } where service is `svc-x` for services/svc-x files. */
export function checkSource(text, ctx, schemas) {
  const code = stripComments(text);
  const out = [];
  const add = (rule, detail) => out.push({ rule, file: ctx.rel, detail });

  for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)(['"])([^'"]+)\1/g)) {
    const spec = m[2];
    const hop = spec.match(/(?:^|\/)services\/(svc-[a-z0-9-]+)\//) ?? spec.match(/^(?:\.\.\/)+(svc-[a-z0-9-]+)\//);
    if (hop && hop[1] !== ctx.service) add('B-hops', `imports ${spec}`);
    if (/(?:^|\/)apps\/[a-z0-9-]+\//.test(spec) && ctx.group !== 'apps') add('B-hops', `imports ${spec}`);
  }

  if (ctx.group === 'services' && ctx.service) {
    const own = schemaOf(ctx.service);
    for (const t of code.matchAll(/sql`([\s\S]*?)`/g)) {
      for (const q of t[1].matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-z_]+)"?\.[a-z_"]+/gi)) {
        const schema = q[1].toLowerCase();
        if (schema !== own && schemas.includes(schema)) add('B-sql', `queries ${schema}.* from ${ctx.service}`);
      }
    }
  }

  const ledgerOwner = ctx.rel.startsWith('packages/ledger-client/') || ctx.rel.startsWith('services/svc-ledger/');
  // A ledger entry carries `direction`; audit logs and lists also have an `entries` field and are not ledger postings.
  if (!ledgerOwner && /\bentries\s*:\s*\[[^\]]{0,300}?\bdirection\s*:/.test(code)) add('M-entries', 'assembles ledger entries inline');

  if (!ledgerOwner) {
    if (/\bimplements\s+(?:[\w.]+\s*,\s*)*LedgerClient\b/.test(code))
      add('M-client', 'implements LedgerClient outside the ledger packages');
    if (/\bfetch\([^)]*\/trpc\/post\b/.test(code)) add('M-client', 'posts to the ledger path directly');
  }

  if (ctx.group === 'services' || ctx.rel.startsWith('packages/ledger-client/')) {
    for (const m of code.matchAll(/idempotencyKey\s*[:=][^\n;]*/g)) {
      if (/randomUUID\s*\(|Date\.now\s*\(/.test(m[0])) add('M-key', 'idempotency key built from randomUUID/Date.now');
    }
  }
  return out;
}

const BALANCE_COLUMN = /^\s*"?([a-z_]*(?:balance|available|held|hold_amount)[a-z_]*)"?\s+(?:numeric|bigint|integer|decimal|text)\b/i;

export function checkMigration(text, ctx) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(BALANCE_COLUMN);
    if (m) out.push({ rule: 'M-balance', file: ctx.rel, detail: `column ${m[1].toLowerCase()}` });
  }
  return out;
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
  const findings = [...packageDeps(root)];
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
        findings.push(...checkSource(readFileSync(f, 'utf8'), { rel, group, service }, schemas));
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
  return { findings, files, schemas: schemas.length };
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
  const f = { rule: 'B-deps', file: 'a/package.json', detail: 'devDependencies @intafaced/svc-x' };
  eq(applyAllow([f], [{ rule: 'B-deps', file: 'a/package.json', reason: 'r' }]).open, [], 'allowed');
  eq(applyAllow([], [{ rule: 'B-deps', file: 'a/package.json', reason: 'r' }]).stale.length, 1, 'stale allow entry');
  console.log('✓ boundary-scan --self-test OK (14 fixtures)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  const { findings, files, schemas } = scan();
  if (files === 0 || schemas === 0) {
    console.error(
      `\n✖ BOUNDARY SCAN FAILED — scope is EMPTY (${files} source file(s), ${schemas} service schema(s)). A scan of nothing is not a pass.\n`,
    );
    process.exit(1);
  }
  const allow = existsSync(join(ROOT, ALLOW_FILE)) ? JSON.parse(readFileSync(join(ROOT, ALLOW_FILE), 'utf8')).allow : [];
  const { open, stale } = applyAllow(findings, allow);
  if (open.length || stale.length) {
    console.error(
      `\n✖ BOUNDARY SCAN FAILED — ${open.length} violation(s), ${stale.length} stale allow entr${stale.length === 1 ? 'y' : 'ies'}\n`,
    );
    for (const f of open) console.error(`  [${f.rule}] ${f.file}\n    → ${f.detail}\n`);
    for (const a of stale) console.error(`  stale in ${ALLOW_FILE}: [${a.rule}] ${a.file} — matches nothing, delete it\n`);
    process.exit(1);
  }
  console.log(`✓ boundary-scan clean — ${files} source file(s), ${schemas} service schema(s), ${allow.length} allowed exception(s)`);
}
