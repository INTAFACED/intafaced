import { describe, expect, it } from 'vitest';
import { BANK_SPACES_LIST } from '@intafaced/contracts/bank-spaces-list';
import { createBankRouter } from './router.js';

/**
 * Each call svc-bank serves from a written record (`@intafaced/contracts/procedure`) is mounted with that record's own
 * schemas: the path the record names exists on the root router, and its input and output parsers are the record's, not
 * a copy. A copy would compile and drift; this fails instead.
 */
describe('svc-bank serves its recorded calls from their records', () => {
  const procedures = (
    createBankRouter({} as never) as unknown as { _def: { procedures: Record<string, { _def: { inputs: unknown[]; output?: unknown } }> } }
  )._def.procedures;

  it.each([BANK_SPACES_LIST])('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-bank');
    const mounted = procedures[record.path];
    expect(mounted, `${record.path} is not on svc-bank's router`).toBeDefined();
    expect(mounted!._def.inputs).toContain(record.input);
    expect(mounted!._def.output).toBe(record.output);
  });
});
