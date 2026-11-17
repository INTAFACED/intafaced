import { describe, expect, it } from 'vitest';
import { createAgentsRouter } from './router.js';
import type { AgentsRouterDeps } from './router.js';
import { isSessionRead, sessionReadInputs } from './session-reads.js';

// Ids shaped as the service's own (uuids); only their shape matters to a schema.
const IDS = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  runId: '44444444-4444-4444-8444-444444444444',
  requestId: '33333333-3333-4333-8333-333333333333:first',
  sessionB: '55555555-5555-4555-8555-555555555555',
};

interface ProcedureDef {
  readonly type: string;
  readonly inputs: ReadonlyArray<{ parse(input: unknown): unknown }>;
}
// The router's procedures as tRPC keeps them (path → definition); deps are never called while it is only listed.
const procedures = (): Array<[string, { _def: ProcedureDef }]> =>
  Object.entries(createAgentsRouter({ runtime: {}, gateway: {} } as AgentsRouterDeps)._def.procedures) as Array<
    [string, { _def: ProcedureDef }]
  >;

describe('the session API reads (session-reads.ts) and the router', () => {
  it("lists exactly the router's session reads: a read added to the router fails here until it is listed with an input", () => {
    const reads = procedures()
      .filter(([path, p]) => p._def.type === 'query' && isSessionRead(path))
      .map(([path]) => path)
      .sort();
    expect(Object.keys(sessionReadInputs(IDS)).sort()).toEqual(reads);
  });

  it('gives each read an input its own schema accepts, so J-agents-12 #1 meets the scope check, not a parse error', () => {
    const byPath = new Map(procedures());
    for (const [path, input] of Object.entries(sessionReadInputs(IDS))) {
      const def = byPath.get(path)?._def;
      expect(def, path).toBeDefined();
      for (const schema of def?.inputs ?? []) expect(() => schema.parse(input), path).not.toThrow();
    }
  });
});
