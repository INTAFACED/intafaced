#!/usr/bin/env node
/**
 * The developer portal publishes every /api/v1 route svc-trade serves: services/svc-trade/src/published-routes.txt,
 * which the customer app's developers-reference.test.ts holds to its REST_REFERENCE. This gate holds that list to the
 * routes svc-trade registers, with their access and scopes, and runs from .githooks/pre-push (gates.mjs --before-push).
 *
 * It was svc-trade's published-route-list.test.ts, which said it ran on the pre-push hook; the hook runs no unit tests,
 * so a route added without its list line was first seen as a red Tests job: the first cause of a lost push in #8518 and
 * #8571 (project-state#3005). Before that it was first seen on CI's customer tests (#8079, #8102, #8142, #8146).
 *
 * The parser is svc-trade's own (route-declarations.test-harness.ts), which developers-reference.test.ts also runs.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = join(ROOT, 'services/svc-trade/src');
const HARNESS = join(SRC, 'route-declarations.test-harness.ts');
const LIST = join(SRC, 'published-routes.txt');
const FIX =
  "give each route its row in the customer app's REST_REFERENCE (apps/customer/src/features/developers/developers-reference.ts), " +
  'then rewrite the list: cd apps/customer && WRITE_ROUTE_LIST=1 pnpm vitest run src/features/developers/developers-reference.test.ts';

/** The lines `served` has that `published` lacks, and the reverse. */
function routeListDiff(served, published) {
  const have = new Set(published);
  const want = new Set(served);
  return { unlisted: served.filter((line) => !have.has(line)), stale: published.filter((line) => !want.has(line)) };
}

async function main() {
  for (const file of [HARNESS, LIST])
    if (!existsSync(file)) {
      console.error(`✖ PUBLISHED ROUTES FAILED — ${file.slice(ROOT.length + 1)} is missing`);
      process.exit(1);
    }
  const { declarationKey, isRouteSource, tradeDeclarations } = await import(pathToFileURL(HARNESS).href);
  const files = readdirSync(SRC, { recursive: true })
    .filter((file) => file.endsWith('.ts') && isRouteSource(file))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));
  const declared = tradeDeclarations(files);
  if (declared.length < 100) {
    console.error(`✖ PUBLISHED ROUTES FAILED — read ${declared.length} svc-trade routes, fewer than 100: the parser lost them`);
    process.exit(1);
  }
  const served = [...new Set(declared.map(declarationKey))].sort();
  const published = readFileSync(LIST, 'utf8').split('\n').filter(Boolean);
  const { unlisted, stale } = routeListDiff(served, published);
  const unsorted = published.some((line, i) => i > 0 && published[i - 1] >= line);
  if (!unlisted.length && !stale.length && !unsorted) {
    console.log(`✓ published routes: the ${served.length} routes svc-trade registers are its published list`);
    return;
  }
  console.error('✖ PUBLISHED ROUTES FAILED — services/svc-trade/src/published-routes.txt is not the routes svc-trade registers');
  for (const line of unlisted) console.error(`  registered, not listed: ${line}`);
  for (const line of stale) console.error(`  listed, not registered: ${line}`);
  if (unsorted) console.error('  the list is not sorted, one route per line');
  console.error(`  Fix: ${FIX}`);
  process.exit(1);
}

await main();
