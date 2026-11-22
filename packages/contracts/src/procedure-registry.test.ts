import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { BANK_SPACES_LIST } from './bank-spaces-list.js';
import {
  defineProcedure,
  NO_INPUT,
  procedureJsonSchema,
  procedureSchemaFiles,
  replyAccepted,
  routePath,
  type ProcedureRecord,
} from './procedure.js';
import { CONTRACT_PROCEDURES } from './procedure-registry.js';
import { jsonValueSchema } from './procedure-strict-schema.js';
import { committedProcedureSchemas, procedureSchemaDrift, sampleDisagreements } from './procedure-sides.js';
import { TAX_LOT_BOOK, TAX_SET_DAY_METHOD } from './tax-procedures.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const committedSchemas = () => committedProcedureSchemas(new URL('../procedures/', import.meta.url));
const WRITE = 'pnpm --filter @intafaced/contracts procedures:write';

/** A minimal record to plant faults in. */
const plant = (over: Partial<ProcedureRecord>): ProcedureRecord =>
  ({
    name: 'plant.call',
    service: 'svc-tax',
    transport: 'trpc',
    kind: 'query',
    path: 'plant',
    access: { caller: 'public' },
    refusals: {},
    input: z.object({ a: z.string() }),
    output: z.object({ ok: z.boolean() }),
    samples: [
      { verdict: 'accept', input: { a: 'x' } },
      { verdict: 'refuse', input: {} },
    ],
    ...over,
  }) as ProcedureRecord;

describe('the written records of calls', () => {
  it('procedures/ is what the records say, one file per service', () => {
    expect(procedureSchemaDrift(committedSchemas(), CONTRACT_PROCEDURES, WRITE)).toEqual([]);
  });

  it('each service has its own file, holding only its own records, so one change touches one service', () => {
    const files = procedureSchemaFiles(CONTRACT_PROCEDURES);
    expect(Object.keys(files)).toEqual([...new Set(CONTRACT_PROCEDURES.map((r) => `${r.service}.schema.json`))].sort());
    for (const [name, text] of Object.entries(files)) {
      const services = Object.values(JSON.parse(text).procedures as Record<string, { service: string }>).map((r) => r.service);
      expect(new Set(services)).toEqual(new Set([name.replace(/\.schema\.json$/, '')]));
    }
  });

  it('a missing file, a stale file and a drifted file are each named, with the command that fixes them', () => {
    const { 'svc-tax.schema.json': tax, ...rest } = committedSchemas();
    expect(procedureSchemaDrift(rest, CONTRACT_PROCEDURES, WRITE)).toEqual([`procedures/svc-tax.schema.json is missing: run \`${WRITE}\``]);
    const stale = { ...committedSchemas(), 'svc-gone.schema.json': '{"procedures":{}}' };
    expect(procedureSchemaDrift(stale, CONTRACT_PROCEDURES, WRITE)).toEqual([
      `procedures/svc-gone.schema.json holds no service's records: run \`${WRITE}\`, which deletes it`,
    ]);
    const file = JSON.parse(tax ?? '');
    delete file.procedures['tax.lotBook'];
    expect(procedureSchemaDrift({ ...rest, 'svc-tax.schema.json': JSON.stringify(file) }, CONTRACT_PROCEDURES, WRITE)).toEqual([
      `procedures/svc-tax.schema.json is not what its records say: run \`${WRITE}\``,
    ]);
  });

  it('the registry is every `defineProcedure` in src/, written by code (run `procedures:write` when this fails)', () => {
    expect(() =>
      execFileSync('node', ['scripts/procedure-registry.mjs', '.', 'CONTRACT_PROCEDURES', './procedure.js', '--check'], {
        cwd: PACKAGE,
        stdio: 'pipe',
      }),
    ).not.toThrow();
    expect(CONTRACT_PROCEDURES.map((r) => r.name)).toEqual(expect.arrayContaining(['tax.health', 'tax.exportPack']));
    expect(CONTRACT_PROCEDURES.filter((r) => r.service === 'svc-tax')).toHaveLength(12);
  });

  it("every record's samples get the same verdict from its zod schema and from its committed JSON export", () => {
    expect(sampleDisagreements(CONTRACT_PROCEDURES, committedSchemas())).toEqual([]);
  });

  it('a sample whose verdict the record does not reach is a disagreement', () => {
    const wrong = {
      ...TAX_SET_DAY_METHOD,
      samples: [{ verdict: 'accept', input: { day: '2026-02-30', assetId: null, method: null } }],
    } as ProcedureRecord;
    expect(sampleDisagreements([wrong], committedSchemas())).toEqual([expect.stringContaining('zod says refuse, the record says accept')]);
  });

  it('a JSON export that drifted from the record is a disagreement (here: the method enum widened)', () => {
    const file = JSON.parse(committedSchemas()['svc-tax.schema.json'] ?? '');
    file.procedures['tax.lotBook'].input.properties.method.enum.push('NEWEST');
    expect(sampleDisagreements([TAX_LOT_BOOK], { 'svc-tax.schema.json': JSON.stringify(file) })).toEqual([
      expect.stringContaining('the JSON export says accept, it should refuse'),
    ]);
  });

  describe('the export refuses what JSON Schema would erase, rather than erasing it', () => {
    it('an unnamed refinement', () => {
      expect(() => procedureJsonSchema(plant({ input: z.object({ a: z.string().refine((v) => v !== 'x') }) }))).toThrow(
        'input.a (.refine/.superRefine',
      );
    });
    it('a named check that no longer names a refinement', () => {
      expect(() => procedureJsonSchema(plant({ checks: { gone: { at: 'input.a', says: 'was there' } } }))).toThrow(
        'input check gone names no refinement here',
      );
    });
    it("an answer's refinement unless `outputChecks` names it where it sits, and a name that names none", () => {
      const output = z.object({ cap: z.number().refine((v) => v >= 0) });
      expect(() => procedureJsonSchema(plant({ output }))).toThrow('.output.cap (.refine/.superRefine');
      const json = procedureJsonSchema(
        plant({ output, outputChecks: { cap_holds: { at: 'output.cap', says: 'a cap is never negative' } } }),
      );
      expect(json.outputChecks).toEqual({ cap_holds: { at: 'output.cap', says: 'a cap is never negative' } });
      expect(() => procedureJsonSchema(plant({ outputChecks: { gone: { at: 'output.a', says: 'was there' } } }))).toThrow(
        'output check gone names no refinement here',
      );
    });
    it('an input or output that accepts anything', () => {
      expect(() => procedureJsonSchema(plant({ input: z.object({ a: z.unknown() }) }))).toThrow('z.unknown');
      expect(() => procedureJsonSchema(plant({ output: z.object({ a: z.any() }) }))).toThrow('z.any');
    });
    it('a declared JSON value (`jsonValueSchema`), written whole', () => {
      const json = procedureJsonSchema(plant({ output: z.object({ a: jsonValueSchema }) }));
      expect(JSON.stringify(json.output)).toContain('"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"}');
    });
    it('a `z.lazy`, forward or recursive, written exactly (a cycle as `$ref`), and what it points to still checked', () => {
      // svc-campaigns' shapes: a rule tree whose parts are trees, and a field named before its schema.
      type Tree = { op: 'all' | 'any'; parts: Tree[] } | { fact: string };
      const tree: z.ZodType<Tree> = z.lazy(() =>
        z.union([z.object({ op: z.enum(['all', 'any']), parts: z.array(tree).max(8) }).strict(), z.object({ fact: z.string() }).strict()]),
      );
      const record = plant({
        input: z.object({ tree }).strict(),
        output: z.object({ limits: z.lazy(() => limits).nullish() }),
        samples: [
          { verdict: 'accept', input: { tree: { op: 'all', parts: [{ fact: 'kyc' }, { op: 'any', parts: [] }] } } },
          { verdict: 'refuse', input: { tree: { op: 'all', parts: [{ fact: 1 }] } } },
          { verdict: 'refuse', input: { tree: { op: 'all', parts: [{ op: 'none', parts: [] }] } } },
        ],
      });
      const limits = z.object({ cap: z.string() });
      const json = procedureJsonSchema(record);
      expect(JSON.stringify(json.input)).toContain('"$ref"');
      expect(json.output).toMatchObject({
        properties: { limits: { anyOf: [{ properties: { cap: { type: 'string' } } }, { type: 'null' }] } },
      });
      const files = procedureSchemaFiles([record]);
      expect(sampleDisagreements([record], files)).toEqual([]);
      const hidden: z.ZodType = z.lazy(() => z.object({ next: hidden.optional(), at: z.string().refine((v) => v !== '') }));
      expect(() => procedureJsonSchema(plant({ output: z.object({ a: z.lazy(() => z.unknown()) }) }))).toThrow('z.unknown');
      expect(() => procedureJsonSchema(plant({ output: hidden }))).toThrow('output.at (.refine');
    });
    it('keeps an optional root as `inputOptional`, never as a required object', () => {
      expect(procedureJsonSchema(TAX_LOT_BOOK)).toMatchObject({ inputOptional: true, input: { type: 'object' } });
      expect(procedureJsonSchema(plant({ input: NO_INPUT, samples: [{ verdict: 'accept' }] }))).toMatchObject({ input: null });
    });
    it('carries each named check and every sample', () => {
      const json = procedureJsonSchema(TAX_SET_DAY_METHOD);
      expect(json.checks).toEqual({ 'tax.day_exists': { at: 'input.day', says: expect.any(String) } });
      expect(json.samples).toContainEqual({
        verdict: 'refuse',
        by: 'tax.day_exists',
        input: { day: '2026-02-30', assetId: null, method: 'FIFO' },
      });
    });
  });

  describe("a caller's own checks over the reply live in the record (`accept`)", () => {
    const strict = plant({
      output: z.object({ ok: z.boolean() }),
      accept: {
        'plant.ok_is_true': { says: 'the reply says ok', holds: (reply) => z.object({ ok: z.literal(true) }).safeParse(reply).success },
      },
    });
    it('every check must hold for the reply to be accepted', () => {
      expect(replyAccepted(strict, { ok: true })).toBe(true);
      expect(replyAccepted(strict, { ok: false })).toBe(false);
      expect(replyAccepted(plant({}), { ok: false })).toBe(true);
    });
    it('the export names each check and its rule, for other callers to carry', () => {
      expect(procedureJsonSchema(strict)).toMatchObject({ accept: { 'plant.ok_is_true': 'the reply says ok' } });
    });
  });

  describe('a record is refused when it is declared', () => {
    it('without a refused and an accepted sample', () => {
      expect(() => defineProcedure(plant({ samples: [{ verdict: 'accept', input: { a: 'x' } }] }))).toThrow(
        'at least one accepted input and one refused input',
      );
    });
    it('with a named input check no sample is refused by', () => {
      expect(() => defineProcedure(plant({ checks: { c: { at: 'input.a', says: 's' } } }))).toThrow(
        'no sample is refused by input check c',
      );
    });
    it('with route parameters its template does not have', () => {
      expect(() =>
        defineProcedure(
          plant({ transport: 'http', method: 'POST', path: '/p/:id', params: z.object({ other: z.string() }) } as Partial<ProcedureRecord>),
        ),
      ).toThrow('has parameters [id] but the record declares [other]');
    });
  });

  it('a held space reads with no ledger account, and a ledger space must carry one shape', () => {
    const row = {
      id: 's',
      assetId: 'EUR',
      kind: 'primary',
      name: 'TEST',
      goalTarget: null,
      lockedUntil: null,
      unlocksAt: null,
      unlockRequestedAt: null,
      billsPot: null,
      balance: '1',
    };
    const heldAt = {
      label: 'TEST partner',
      asOf: '2026-11-18T00:00:00.000Z',
      figure: { state: 'known', source: 'TEST', amount: '1', asOf: '2026-11-18T00:00:00.000Z', staleAfterMs: 1, reason: null },
    };
    expect(BANK_SPACES_LIST.output.safeParse([{ ...row, ledgerAccount: null, heldAt }]).success).toBe(true);
    expect(BANK_SPACES_LIST.output.safeParse([{ ...row, ledgerAccount: { ownerType: 'user' }, heldAt: null }]).success).toBe(false);
    expect(BANK_SPACES_LIST.output.safeParse([{ ...row, balance: 1, ledgerAccount: null, heldAt }]).success).toBe(false);
  });

  it('a record cannot be changed after it is declared', () => {
    expect(Object.isFrozen(BANK_SPACES_LIST)).toBe(true);
  });

  it('fills an HTTP route template and refuses a missing part', () => {
    const route = { transport: 'http', method: 'POST', path: '/markets/:marketId/orders' } as const;
    expect(routePath(route, { marketId: 'BTC/USDT' })).toBe('/markets/BTC%2FUSDT/orders');
    expect(() => routePath(route, {})).toThrow('needs :marketId');
  });
});

describe('the registry under parallel changes', () => {
  // Two changes off one base, each adding records, merged by git: what `procedures:write` writes must be what the merge
  // leaves (else main goes stale with every PR green), or the merge must conflict.
  const SCRIPT = join(PACKAGE, 'scripts', 'procedure-registry.mjs');
  const record = (name: string) => `export const ${name} = defineProcedure({});\n`;
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-merge-'));
    mkdirSync(join(dir, 'src'));
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
    const write = () => execFileSync('node', [SCRIPT, '.', 'ALL', './procedure.js'], { cwd: dir, stdio: 'pipe' });
    const fresh = () => spawnSync('node', [SCRIPT, '.', 'ALL', './procedure.js', '--check'], { cwd: dir }).status === 0;
    // Each file a few records, the files many, so a fixed-size part would cross files.
    for (const f of ['a', 'b', 'c', 'd', 'e', 'f'])
      writeFileSync(join(dir, 'src', `${f}.ts`), [1, 2, 3].map((n) => record(`${f.toUpperCase()}${n}`)).join(''));
    write();
    git('init', '-q', '-b', 'base');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const change = (branch: string, file: string, name: string) => {
      git('switch', '-q', '-c', branch, 'base');
      appendFileSync(join(dir, 'src', `${file}.ts`), record(name));
      write();
      git('commit', '-qam', branch);
    };
    const merge = (into: string, from: string) => {
      git('switch', '-q', into);
      return git('merge', '-q', '--no-edit', from).status === 0;
    };
    return { change, merge, fresh };
  };

  it('two changes adding records to different files merge into what procedures:write writes', () => {
    const r = repo();
    r.change('x', 'a', 'A4');
    r.change('y', 'b', 'B4');
    expect(r.merge('y', 'x')).toBe(true);
    expect(r.fresh()).toBe(true);
  });

  it('two changes adding records to one file conflict in git, never merge stale', () => {
    const r = repo();
    r.change('x', 'c', 'C4');
    r.change('y', 'c', 'C5');
    expect(r.merge('y', 'x')).toBe(false);
  });
});
