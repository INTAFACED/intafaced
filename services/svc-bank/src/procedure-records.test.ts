import { describe, expect, it } from 'vitest';
import { BANK_SPACES_LIST } from '@intafaced/contracts/bank-spaces-list';
import { createBankRouter } from './router.js';

type Mounted = { _def: { inputs: unknown[]; output?: unknown } };
/** tRPC keeps a router's mounted parsers in `_def.procedures`, keyed by dotted path; its public type does not name them. */
function isProcedureMap(value: unknown): value is Record<string, Mounted> {
  return typeof value === 'object' && value !== null;
}
function mountedProcedures(router: object): Record<string, Mounted> {
  const def: unknown = Reflect.get(router, '_def');
  const procedures: unknown = typeof def === 'object' && def !== null ? Reflect.get(def, 'procedures') : undefined;
  if (!isProcedureMap(procedures)) throw new Error('the router has no _def.procedures');
  return procedures;
}

/**
 * Each call svc-bank serves from a written record (`@intafaced/contracts/procedure`) is mounted with that record's own
 * schemas: the path the record names exists on the root router, and its input and output parsers are the record's, not
 * a copy. A copy would compile and drift; this fails instead.
 */
describe('svc-bank serves its recorded calls from their records', () => {
  const procedures = mountedProcedures(createBankRouter({} as never));

  it.each([BANK_SPACES_LIST])('$name is mounted at its path with its own input and output', (record) => {
    expect(record.service).toBe('svc-bank');
    const mounted = procedures[record.path];
    expect(mounted, `${record.path} is not on svc-bank's router`).toBeDefined();
    expect(mounted!._def.inputs).toContain(record.input);
    expect(mounted!._def.output).toBe(record.output);
  });
});
