import { describe, expect, it } from 'vitest';
import { EDGE_PERIMETER_MODULES } from './flag-state';

/**
 * svc-edge's live route table, imported at run time. Its path is a URL rather than a static specifier only so this app's
 * type program does not pull a services/ file in; the value is the module's real export.
 */
const EDGE_ROUTES_URL = new URL('../../../../services/svc-edge/src/routes.ts', import.meta.url).href;
const { UPSTREAMS } = (await import(EDGE_ROUTES_URL)) as { UPSTREAMS: readonly { module: string }[] };

// The console offers a kill only for a module the edge enforces. That list is copied from svc-edge's route table, so it is
// checked against it here: a module missing from the copy is a working halt the console refuses to arm.
describe('EDGE_PERIMETER_MODULES matches svc-edge UPSTREAMS', () => {
  it('names exactly the modules the edge routes to', () => {
    const edge = new Set(UPSTREAMS.map((u) => u.module));
    expect(edge.size).toBeGreaterThan(10);
    expect([...EDGE_PERIMETER_MODULES].sort()).toEqual([...edge].sort());
  });
});
