/**
 * The developer portal publishes every /api/v1 route svc-trade serves: published-routes.txt, beside this file, which the
 * customer app's developers-reference.test.ts holds to its REST_REFERENCE. This test sits here, in
 * svc-trade, so a change that adds, removes or re-scopes a route fails in the package it touched, on the pre-push hook
 * too, instead of first on CI's customer tests: that was the first cause of a lost push in 4 journey PRs in 7 days
 * (#8079, #8102, #8142, #8146).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { declarationKey, isRouteSource, tradeDeclarations } from './route-declarations.test-harness.js';

const SRC = new URL('./', import.meta.url);
const ROUTE_LIST = new URL('./published-routes.txt', import.meta.url);

const FIX =
  'a route changed: give it its row in REST_REFERENCE (apps/customer/src/features/developers/developers-reference.ts), ' +
  'then rewrite the list with `WRITE_ROUTE_LIST=1 pnpm --filter @intafaced/customer exec vitest run src/features/developers/developers-reference.test.ts`';

describe('the published route list', () => {
  it('names every /api/v1 route svc-trade registers, with its access and scopes, and no route it does not', () => {
    const files = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts') && isRouteSource(file))
      .map((file) => ({ file, text: readFileSync(new URL(file, SRC), 'utf8') }));
    const declared = tradeDeclarations(files);
    expect(declared.length).toBeGreaterThan(100);
    const served = [...new Set(declared.map(declarationKey))].sort();
    const published = readFileSync(ROUTE_LIST, 'utf8').split('\n').filter(Boolean);
    expect(served, FIX).toEqual(published);
  });
});
