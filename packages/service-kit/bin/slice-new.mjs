#!/usr/bin/env node
/**
 * The backend slice scaffold. Writes the files a new backend part of a slice starts from, already on the kit:
 *
 *   services/<service>/drizzle/<UTC stamp>_<name>.sql and .down.sql   one table, owner-scoped, timestamps
 *   services/<service>/src/<dir>/<name>.ts                            refusals, the store, an owner value
 *   services/<service>/src/<dir>/<name>-router.ts                     tRPC procedures: scope, owner check, typed refusals
 *   services/<service>/src/<dir>/<name>.db.test.ts                    the happy path, every failure branch, the invariant
 *
 * The files pass as written, so the slice starts green and every change after is the slice's own. It prints the lines
 * still to add by hand (the router mount, the env value, the TEST owner value): shared files stay one import line each.
 *
 *   pnpm --filter @intafaced/service-kit slice:new -- --service svc-academy --name grade-reports \
 *     --dir curriculum --slice AC-assignments-04 [--area academy] [--scope academy] [--dry-run]
 *
 * It never writes a ledger call: a slice that moves money adds a `packages/ledger-client` recipe by hand.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCOPES } from '@intafaced/auth';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `20261027063012`, the UTC second the migration is written (`tooling/ci/migration-check.mjs` rule 4). */
export function migrationStamp(now = new Date()) {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const words = (name) => name.split('-');
const pascal = (name) =>
  words(name)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
const camel = (name) => pascal(name)[0].toLowerCase() + pascal(name).slice(1);
const snake = (name) => words(name).join('_');

const FLAGS = ['service', 'name', 'slice', 'dir', 'area', 'scope'];

/** Names the templates already use: a slice named for one would declare it twice or shadow it. */
const RESERVED = new Set([
  'sql',
  'stored',
  'row',
  'z',
  'tx',
  'ctx',
  'input',
  'db',
  'store',
  'count',
  'cap',
  'found',
  'rows',
  'created',
  'counted',
]);

export function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--') && FLAGS.includes(a.slice(2))) out[a.slice(2)] = argv[++i];
    else throw new Error(`slice:new: unexpected argument "${a}" (flags: ${FLAGS.map((f) => `--${f}`).join(' ')} --dry-run)`);
  }
  for (const key of ['service', 'name', 'slice']) if (!out[key]) throw new Error(`slice:new: --${key} is required`);
  if (!/^svc-[a-z0-9-]+$/.test(out.service)) throw new Error('slice:new: --service is a folder under services/, like svc-academy');
  if (!kebab.test(out.name)) throw new Error('slice:new: --name is kebab-case, like grade-reports');
  if (RESERVED.has(camel(out.name)) || RESERVED.has(snake(out.name)))
    throw new Error(`slice:new: --name ${out.name} clashes with a name the templates use; pick a more specific one`);
  if (!/^[A-Za-z0-9-]+$/.test(out.slice)) throw new Error('slice:new: --slice is a slice id, like AC-assignments-04');
  if (out.dir !== undefined && !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(out.dir)) throw new Error('slice:new: --dir is a folder under src/');
  out.area ??= out.service.slice('svc-'.length).replace(/-/g, '_');
  if (!/^[a-z][a-z0-9_]*$/.test(out.area)) throw new Error("slice:new: --area is the service's schema name, like academy");
  out.scope ??= out.service.slice('svc-'.length);
  for (const verb of ['read', 'write'])
    if (!SCOPES.includes(`${out.scope}:${verb}`))
      throw new Error(`slice:new: ${out.scope}:${verb} is not a scope in packages/auth; pass --scope with one the service's callers hold`);
  return out;
}

/** The names one slice's files share, worked out once. */
export function sliceNames(opts) {
  const table = snake(opts.name);
  return {
    table,
    Name: pascal(opts.name),
    name_: camel(opts.name),
    capEnv: `${opts.area.toUpperCase()}_${table.toUpperCase()}_CAP`,
    code: (what) => `${opts.area}.${table}_${what}`,
    module: opts.dir ? `./${opts.dir}/${opts.name}` : `./${opts.name}`,
  };
}

/** Every file the scaffold writes, as { path (from the repo root), text }. Pure, so the test reads it. */
export function sliceFiles(opts, now = new Date()) {
  const { service, name, slice, area, scope } = opts;
  const { table, Name, name_, capEnv, code } = sliceNames(opts);
  const stamp = migrationStamp(now);
  const migration = `${stamp}_${table}`;
  const src = join('services', service, 'src', ...(opts.dir ? [opts.dir] : []));
  const drizzle = join('services', service, 'drizzle');
  const up = `-- ${service} · ${name.replace(/-/g, ' ')} (${slice})
-- Reversal: ${migration}.down.sql
--
-- One row per ${name.replace(/-/g, ' ')}, owned by one person. Ids are stable uuids; money, if any is added, is numeric(38,18).

CREATE TABLE IF NOT EXISTS "${area}"."${table}" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"    uuid NOT NULL,
  "title"       text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "${table}_title_chk" CHECK (length("title") BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS "${table}_owner_idx" ON "${area}"."${table}" ("owner_id", "created_at");
`;
  const down = `-- intafaced:destructive — reversal of ${migration}.sql
DROP TABLE IF EXISTS "${area}"."${table}";
`;
  const store = `/**
 * ${slice}: ${name.replace(/-/g, ' ')}.
 *
 * One row per item, owned by the person who made it. How many one person may keep is an owner value
 * (\`${capEnv}\`): blank refuses \`${code('cap_unset')}\` before anything is written. Someone else's item reads as
 * not found. No money moves.
 */
import type { Sql } from 'postgres';
import { defineRefusals, requireOwned, requireSetting } from '@intafaced/service-kit';

export const ${name_}Refusals = defineRefusals('${Name}Error', {
  '${code('not_found')}': 'NOT_FOUND',
  '${code('cap_unset')}': 'PRECONDITION_FAILED',
  '${code('cap_reached')}': 'PRECONDITION_FAILED',
});

export interface ${Name}Row {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly createdAt: string;
}

type Stored = { id: string; owner_id: string; title: string; created_at: Date };

const row = (r: Stored): ${Name}Row => ({ id: r.id, ownerId: r.owner_id, title: r.title, createdAt: r.created_at.toISOString() });

export class ${Name} {
  /** \`cap\` is the owner value as read from env: null when blank. */
  constructor(
    private readonly sql: Sql,
    private readonly cap: number | null,
  ) {}

  async create(input: { readonly ownerId: string; readonly title: string }): Promise<${Name}Row> {
    const cap = requireSetting(this.cap, ${name_}Refusals, '${code('cap_unset')}');
    return this.sql.begin(async (tx) => {
      // One writer per owner at a time, so two creates cannot both pass the cap.
      await tx\`SELECT pg_advisory_xact_lock(hashtext(\${'${table}:' + input.ownerId}))\`;
      const [counted] = await tx<Array<{ n: number }>>\`
        SELECT count(*)::int AS n FROM "${area}"."${table}" WHERE owner_id = \${input.ownerId}
      \`;
      if (counted!.n >= cap) ${name_}Refusals.refuse('${code('cap_reached')}', \`at most \${cap}\`, { limit: String(cap) });
      const [created] = await tx<Stored[]>\`
        INSERT INTO "${area}"."${table}" (owner_id, title) VALUES (\${input.ownerId}, \${input.title})
        RETURNING id, owner_id, title, created_at
      \`;
      return row(created!);
    });
  }

  /** The caller's own item; a missing one and someone else's refuse alike. */
  async get(id: string, caller: { readonly userId: string }): Promise<${Name}Row> {
    const [found] = await this.sql<Stored[]>\`
      SELECT id, owner_id, title, created_at FROM "${area}"."${table}" WHERE id = \${id}
    \`;
    return row(requireOwned(found, (r) => r.owner_id, caller, ${name_}Refusals, '${code('not_found')}'));
  }

  async list(caller: { readonly userId: string }): Promise<${Name}Row[]> {
    const rows = await this.sql<Stored[]>\`
      SELECT id, owner_id, title, created_at FROM "${area}"."${table}" WHERE owner_id = \${caller.userId} ORDER BY created_at, id
    \`;
    return rows.map(row);
  }
}
`;
  const router = `/**
 * ${slice}: the ${name.replace(/-/g, ' ')} procedures. Each one reads the caller from the edge-signed principal, so the
 * owner check is the caller's own id, never an id from the input. Refusals keep their code on the wire.
 */
import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { ${name_}Refusals, type ${Name} } from './${name}.js';

export function ${name_}Procedures(${name_}: ${Name}) {
  return {
    ${name_}Create: scopedProcedure('${scope}:write')
      .input(z.object({ title: z.string().trim().min(1).max(200) }))
      .mutation(({ ctx, input }) => ${name_}Refusals.guard(() => ${name_}.create({ ownerId: ctx.principal!.userId, title: input.title }))),

    ${name_}Get: scopedProcedure('${scope}:read')
      .input(z.object({ id: z.string().guid() }))
      .query(({ ctx, input }) => ${name_}Refusals.guard(() => ${name_}.get(input.id, ctx.principal!))),

    ${name_}List: scopedProcedure('${scope}:read').query(({ ctx }) => ${name_}Refusals.guard(() => ${name_}.list(ctx.principal!))),
  };
}
`;
  const test = `/**
 * ${slice}: ${name.replace(/-/g, ' ')}, against a real database. Every refusal has a test, and a refusal writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { expectRefusal, useServiceDb } from '@intafaced/service-kit/testing';
import { ${Name} } from './${name}.js';

const db = useServiceDb({ service: '${area}', from: import.meta.url });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const store = (cap: number | null = 2) => new ${Name}(db.sql, cap);
const count = async () => (await db.sql<Array<{ n: number }>>\`SELECT count(*)::int AS n FROM "${area}"."${table}"\`)[0]!.n;

describe('${slice} ${name.replace(/-/g, ' ')}', () => {
  it('makes an item the owner reads back and lists', async () => {
    const made = await store().create({ ownerId: A, title: 'First' });
    expect(await store().get(made.id, { userId: A })).toEqual(made);
    expect(await store().list({ userId: A })).toEqual([made]);
  });

  it('refuses ${code('cap_unset')} when the owner left the cap blank, and writes nothing', async () => {
    await expectRefusal(store(null).create({ ownerId: A, title: 'First' }), '${code('cap_unset')}');
    expect(await count()).toBe(0);
  });

  it('refuses ${code('cap_reached')} at the cap, and writes nothing more', async () => {
    await store(1).create({ ownerId: A, title: 'First' });
    await expectRefusal(store(1).create({ ownerId: A, title: 'Second' }), '${code('cap_reached')}');
    expect(await count()).toBe(1);
  });

  it("reads someone else's item as not found, the same as a missing one", async () => {
    const made = await store().create({ ownerId: A, title: 'First' });
    await expectRefusal(store().get(made.id, { userId: B }), '${code('not_found')}');
    await expectRefusal(store().get('33333333-3333-4333-8333-333333333333', { userId: A }), '${code('not_found')}');
    expect(await store().list({ userId: B })).toEqual([]);
  });

  it('holds the cap when two creates race', async () => {
    const results = await Promise.allSettled([
      store(1).create({ ownerId: A, title: 'One' }),
      store(1).create({ ownerId: A, title: 'Two' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count()).toBe(1);
  });
});
`;
  return [
    { path: join(drizzle, `${migration}.sql`), text: up },
    { path: join(drizzle, `${migration}.down.sql`), text: down },
    { path: join(src, `${name}.ts`), text: store },
    { path: join(src, `${name}-router.ts`), text: router },
    { path: join(src, `${name}.db.test.ts`), text: test },
  ];
}

/** What the builder adds by hand, in the shared files, one line each where it can be. */
export function nextSteps(opts) {
  const { service } = opts;
  const { Name, name_, capEnv, module } = sliceNames(opts);
  return [
    `services/${service}/package.json: "@intafaced/service-kit": "workspace:*" in dependencies, then pnpm install`,
    `services/${service}/src/env.ts: ${capEnv}: blankAsUnset(z.coerce.number().int().min(0)),`,
    `services/${service}/src/router.ts: ...${name_}Procedures(new ${Name}(sql, env.${capEnv} ?? null)), from '${module}-router.js'`,
    `services/${service}/src/db/migrate.ts or similar: only if the service lists its migrations by name (svc-ops does), add the new file`,
    `tooling/profiles/test-owner-values/<file whose service key is ${service}>.json: a labelled TEST value for ${capEnv}`,
    `packages/contracts: the input and output schemas, when the screen reads them`,
  ];
}

/** The repo's own Prettier settings, so the files pass the format check as written. SQL is left as written. */
async function formatted(file, cwd) {
  if (!file.path.endsWith('.ts')) return file.text;
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(join(cwd, file.path))) ?? {};
  return prettier.format(file.text, { ...config, filepath: file.path });
}

export async function main(argv, cwd = ROOT, now = new Date()) {
  const opts = parseArgs(argv);
  // The scaffold only checks the target folder exists and writes new files into it; it reads no service's source.
  const target = join(cwd, 'services', opts.service);
  if (!existsSync(target)) throw new Error(`slice:new: services/${opts.service} does not exist`);
  const files = sliceFiles(opts, now);
  for (const f of files) if (existsSync(join(cwd, f.path))) throw new Error(`slice:new: ${f.path} already exists; nothing written`);
  if (!opts.dryRun) {
    const texts = await Promise.all(files.map((f) => formatted(f, cwd)));
    files.forEach((f, i) => {
      mkdirSync(dirname(join(cwd, f.path)), { recursive: true });
      writeFileSync(join(cwd, f.path), texts[i]);
    });
  }
  return [
    `${opts.dryRun ? 'would write' : 'wrote'}:`,
    ...files.map((f) => `  ${f.path}`),
    'still to add by hand:',
    ...nextSteps(opts).map((step) => `  ${step}`),
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
