import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { procedureSchemaFile } from '@intafaced/contracts/procedure';
import { sampleDisagreements } from '@intafaced/contracts/procedure-sides';
import { LEDGER_PROCEDURES } from './procedure-registry.js';

describe("the written records of the ledger's doors", () => {
  it('procedures.schema.json is what the records say (run `pnpm --filter @intafaced/ledger-client procedures:write`)', () => {
    const committed = readFileSync(new URL('../procedures.schema.json', import.meta.url), 'utf8');
    expect(JSON.parse(committed)).toEqual(JSON.parse(procedureSchemaFile(LEDGER_PROCEDURES)));
  });

  it('the registry is every `defineProcedure` in src/, written by code (run `procedures:write` when this fails)', () => {
    const args = ['../contracts/scripts/procedure-registry.mjs', '.', 'LEDGER_PROCEDURES', '@intafaced/contracts/procedure', '--check'];
    expect(() => execFileSync('node', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' })).not.toThrow();
  });

  it('holds the history door, and contracts holds none of the ledger records (so contracts never depends on this package)', () => {
    expect(LEDGER_PROCEDURES.map((r) => r.name)).toEqual(['ledger.historyPage']);
  });

  it("every record's samples get the same verdict from its zod schema and from its committed JSON export", () => {
    const committed = readFileSync(new URL('../procedures.schema.json', import.meta.url), 'utf8');
    expect(sampleDisagreements(LEDGER_PROCEDURES, committed)).toEqual([]);
  });
});
