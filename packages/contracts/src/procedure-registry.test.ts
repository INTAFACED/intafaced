import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { BANK_SPACES_LIST } from './bank-spaces-list.js';
import {
  defineProcedure,
  NO_INPUT,
  procedureJsonSchema,
  procedureSchemaFile,
  replyAccepted,
  routePath,
  type ProcedureRecord,
} from './procedure.js';
import { CONTRACT_PROCEDURES } from './procedure-registry.js';
import { sampleDisagreements } from './procedure-sides.js';
import { TAX_LOT_BOOK, TAX_SET_DAY_METHOD } from './tax-procedures.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const committedSchema = () => readFileSync(new URL('../procedures.schema.json', import.meta.url), 'utf8');

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
  it('procedures.schema.json is what the records say (run `pnpm --filter @intafaced/contracts procedures:write`)', () => {
    const committed = readFileSync(new URL('../procedures.schema.json', import.meta.url), 'utf8');
    expect(JSON.parse(committed)).toEqual(JSON.parse(procedureSchemaFile(CONTRACT_PROCEDURES)));
  });

  it('the registry is every `defineProcedure` in src/, written by code (run `procedures:write` when this fails)', () => {
    expect(() =>
      execFileSync('node', ['scripts/procedure-registry.mjs', '.', 'CONTRACT_PROCEDURES', './procedure.js', '--check'], {
        cwd: PACKAGE,
        stdio: 'pipe',
      }),
    ).not.toThrow();
    expect(CONTRACT_PROCEDURES.map((r) => r.name)).toEqual(expect.arrayContaining(['ledger.historyPage', 'tax.health', 'tax.exportPack']));
    expect(CONTRACT_PROCEDURES.filter((r) => r.service === 'svc-tax')).toHaveLength(12);
  });

  it("every record's samples get the same verdict from its zod schema and from its committed JSON export", () => {
    expect(sampleDisagreements(CONTRACT_PROCEDURES, committedSchema())).toEqual([]);
  });

  it('a sample whose verdict the record does not reach is a disagreement', () => {
    const wrong = {
      ...TAX_SET_DAY_METHOD,
      samples: [{ verdict: 'accept', input: { day: '2026-02-30', assetId: null, method: null } }],
    } as ProcedureRecord;
    expect(sampleDisagreements([wrong], committedSchema())).toEqual([expect.stringContaining('zod says refuse, the record says accept')]);
  });

  it('a JSON export that drifted from the record is a disagreement (here: the method enum widened)', () => {
    const file = JSON.parse(committedSchema());
    file.procedures['tax.lotBook'].input.properties.method.enum.push('NEWEST');
    expect(sampleDisagreements([TAX_LOT_BOOK], JSON.stringify(file))).toEqual([
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
    it('an input or output that accepts anything', () => {
      expect(() => procedureJsonSchema(plant({ input: z.object({ a: z.unknown() }) }))).toThrow('z.unknown');
      expect(() => procedureJsonSchema(plant({ output: z.object({ a: z.any() }) }))).toThrow('z.any');
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
