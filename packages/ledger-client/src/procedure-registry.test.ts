import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { committedProcedureSchemas, procedureSchemaDrift, sampleDisagreements } from '@intafaced/contracts/procedure-sides';
import { LEDGER_PROCEDURES } from './procedure-registry.js';

const committed = () => committedProcedureSchemas(new URL('../procedures/', import.meta.url));

describe("the written records of the ledger's doors", () => {
  it('procedures/ is what the records say, one file per service', () => {
    expect(procedureSchemaDrift(committed(), LEDGER_PROCEDURES, 'pnpm --filter @intafaced/ledger-client procedures:write')).toEqual([]);
  });

  it('the registry is every `defineProcedure` in src/, written by code (run `procedures:write` when this fails)', () => {
    const args = ['../contracts/scripts/procedure-registry.mjs', '.', 'LEDGER_PROCEDURES', '@intafaced/contracts/procedure', '--check'];
    expect(() => execFileSync('node', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' })).not.toThrow();
  });

  it('holds the history and postRecipe doors, and contracts holds none of the ledger records (so contracts never depends on this package)', () => {
    expect(LEDGER_PROCEDURES.map((r) => r.name)).toEqual(['ledger.historyPage', 'ledger.postRecipe']);
  });

  it("every record's samples get the same verdict from its zod schema and from its committed JSON export", () => {
    expect(sampleDisagreements(LEDGER_PROCEDURES, committed())).toEqual([]);
  });
});
