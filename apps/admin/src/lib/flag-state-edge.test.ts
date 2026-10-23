import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDGE_PERIMETER_MODULES } from './flag-state';

// The console offers a kill only for a module the edge enforces. That list is copied from svc-edge's route table, so it is
// checked against it here: a module missing from the copy is a working halt the console refuses to arm.
describe('EDGE_PERIMETER_MODULES matches svc-edge UPSTREAMS', () => {
  it('names exactly the modules the edge routes to', () => {
    const routes = readFileSync(fileURLToPath(new URL('../../../../services/svc-edge/src/routes.ts', import.meta.url)), 'utf8');
    const table = routes.slice(routes.indexOf('UPSTREAMS'), routes.indexOf('ENFORCEABLE_MODULES'));
    const edge = new Set([...table.matchAll(/\bmodule: '([a-z0-9-]+)'/g)].map((m) => m[1]));
    expect(edge.size).toBeGreaterThan(10);
    expect([...EDGE_PERIMETER_MODULES].sort()).toEqual([...edge].sort());
  });
});
