/**
 * CUSTODY SCAN, CHECK 4 — the custody switch (OWNER 226: INTAFACED launches holding no customer money).
 *
 * The custodial layer stays built and is switched off at launch. svc-ledger refuses a customer-balance post while
 * `LEDGER_CUSTODY_LAYER` is off (its default). This check is the static half: with the switch's default off, every
 * source file that posts a recipe moving a customer balance must be a site the reviewed inventory names as part of the
 * custodial layer (`tooling/ci/custody-layer-inventory.json`). A NEW customer-balance posting anywhere in services/ or
 * packages/ fails the scan until a reviewed change adds it to the inventory, which says, in review, "this is custody".
 *
 * It fails closed:
 *   · the switch's default is read from source (ledger-client's parser, svc-ledger's env and service) and must be off;
 *   · the inventory's list of customer-balance recipes is pinned to the ledger's own recipe samples by
 *     services/svc-ledger/src/custody-layer-inventory.test.ts, so a new recipe that touches a customer account cannot be
 *     left off the list;
 *   · a dynamic recipe call (`recipes[name](...)`) counts as a posting of every customer recipe (`*`).
 *
 * WHAT IT DOES NOT SEE (named, not hidden): a recipe reached through an alias of the `recipes` object assigned to
 * another variable, or a post assembled from a recipe returned by a helper in another file (that file is the site).
 * tooling/ and apps/ are not walked: tooling posts only against the TEST stack and apps never post.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const INVENTORY_PATH = 'tooling/ci/custody-layer-inventory.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', 'drizzle', 'target', '.git', 'testing', '__tests__']);
const TEST_FILE = /\.(test|spec|testkit|fixture|fixtures)\.[cm]?tsx?$|\.pw\.[cm]?[jt]s$/;
const LEDGER_CLIENT_SRC = 'packages/ledger-client/';
/** Names every recipe to sample its shape for the HTTP door's allowlist; it posts none of them. */
const NOT_A_POSTING_SITE = new Set(['services/svc-ledger/src/recipe-gate.ts']);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.[cm]?tsx?$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

/**
 * The customer-balance recipes a source text posts. Returns a sorted list of recipe names, `*` for a dynamic call.
 * Pure: takes the file's text, so the test can plant one.
 */
export function customerRecipeCalls(text, customerRecipes) {
  const found = new Set();
  const customer = new Set(customerRecipes);

  // recipes.name( — and the same through an import alias of `recipes` (`import { recipes as r }`).
  const recipeObjects = new Set(['recipes']);
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]@intafaced\/ledger-client(?:\/recipes)?['"]/gs;
  const named = new Map(); // local name -> recipe name
  for (const m of text.matchAll(importRe)) {
    for (const raw of m[1].split(',')) {
      const spec = raw.replace(/\btype\s+/, '').trim();
      if (!spec) continue;
      const [imported, local] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (imported === 'recipes') recipeObjects.add(local ?? imported);
      else if (customer.has(imported)) named.set(local ?? imported, imported);
    }
  }
  // `import * as ledger from '@intafaced/ledger-client'` → ledger.recipes.x( and ledger.x(
  for (const m of text.matchAll(/import\s*\*\s*as\s+(\w+)\s+from\s*['"]@intafaced\/ledger-client(?:\/recipes)?['"]/g)) {
    recipeObjects.add(`${m[1]}.recipes`);
    recipeObjects.add(m[1]);
  }

  for (const obj of recipeObjects) {
    const o = obj.replace(/\./g, '\\s*\\.\\s*');
    for (const m of text.matchAll(new RegExp(`\\b${o}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g'))) if (customer.has(m[1])) found.add(m[1]);
    if (new RegExp(`\\b${o}\\s*\\[`).test(text)) found.add('*');
  }
  for (const [local, recipe] of named) {
    if (new RegExp(`(?<![.\\w])${local}\\s*\\(`).test(text)) found.add(recipe);
  }
  return [...found].sort();
}

/** Every customer-balance posting site under services/ and packages/ (ledger-client itself excluded). */
export function customerPostingSites(root, customerRecipes) {
  const sites = {};
  for (const top of ['services', 'packages']) {
    for (const file of walk(join(root, top))) {
      const rel = relative(root, file).split(sep).join('/');
      if (rel.startsWith(LEDGER_CLIENT_SRC) || NOT_A_POSTING_SITE.has(rel) || TEST_FILE.test(rel)) continue;
      const calls = customerRecipeCalls(readFileSync(file, 'utf8'), customerRecipes);
      if (calls.length > 0) sites[rel] = calls;
    }
  }
  return sites;
}

/**
 * Is the switch's default off? Read from source, so the check can't be satisfied by an inventory alone.
 * Returns a list of problems; empty means off by default in all three places.
 */
export function switchDefaultProblems(root) {
  const problems = [];
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
  const parser = read('packages/ledger-client/src/custody-layer.ts');
  if (!parser || !/raw\.trim\(\)\s*===\s*''\)\s*return\s*'off'/.test(parser)) {
    problems.push("packages/ledger-client/src/custody-layer.ts: parseCustodyLayer must read unset or blank as 'off'");
  }
  const env = read('services/svc-ledger/src/env.ts');
  const envBlock = env?.match(/LEDGER_CUSTODY_LAYER:[\s\S]{0,400}?parseCustodyLayer\(/)?.[0];
  if (!envBlock || /\.default\(/.test(envBlock)) {
    problems.push('services/svc-ledger/src/env.ts: LEDGER_CUSTODY_LAYER must be parsed by parseCustodyLayer, with no other default');
  }
  const service = read('services/svc-ledger/src/service.ts');
  if (!service || !/this\.custodyLayer\s*=\s*options\.custodyLayer\s*\?\?\s*'off'/.test(service)) {
    problems.push("services/svc-ledger/src/service.ts: LedgerService must default custodyLayer to 'off'");
  }
  if (!service || !/this\.custodyLayer\s*===\s*'off'\s*&&\s*movesCustomerBalance\(/.test(service)) {
    problems.push('services/svc-ledger/src/service.ts: LedgerService.post must refuse a customer-balance post while the layer is off');
  }
  return problems;
}

/** Compare the sites found with the inventory. New sites or new recipes at a site are violations; stale rows are notices. */
export function judgeCustodyLayer(found, inventorySites) {
  const violations = [];
  const stale = [];
  for (const [file, calls] of Object.entries(found)) {
    const allowed = new Set(inventorySites[file] ?? []);
    const extra = calls.filter((c) => !allowed.has(c));
    if (extra.length > 0) violations.push({ file, recipes: extra });
  }
  for (const [file, calls] of Object.entries(inventorySites)) {
    const have = new Set(found[file] ?? []);
    const gone = calls.filter((c) => !have.has(c));
    if (gone.length > 0) stale.push({ file, recipes: gone });
  }
  return { violations, stale };
}

export function readInventory(root) {
  const path = join(root, INVENTORY_PATH);
  if (!existsSync(path)) throw new Error(`${INVENTORY_PATH} is missing: the custodial-layer inventory is what this check compares against`);
  const inv = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(inv.customerBalanceRecipes) || inv.customerBalanceRecipes.length === 0) {
    throw new Error(`${INVENTORY_PATH}: customerBalanceRecipes is empty or missing; an empty list would scan nothing`);
  }
  if (typeof inv.sites !== 'object' || inv.sites === null) throw new Error(`${INVENTORY_PATH}: sites is missing`);
  return inv;
}

/** Run check 4. Returns { violations: [{check,file,reason,detail}], notices: [string], summary: string }. */
export function runCustodyLayerCheck(root) {
  const out = { violations: [], notices: [], summary: '' };
  for (const p of switchDefaultProblems(root)) {
    out.violations.push({
      check: 'custody-switch-default',
      file: p.split(':')[0],
      reason: p.slice(p.indexOf(':') + 2),
      detail: 'With the custody switch off by default, no customer money is held (OWNER 226). This check only means something while it is.',
    });
  }
  const inv = readInventory(root);
  const found = customerPostingSites(root, inv.customerBalanceRecipes);
  const { violations, stale } = judgeCustodyLayer(found, inv.sites);
  for (const v of violations) {
    out.violations.push({
      check: 'customer-balance-posting',
      file: v.file,
      reason: `posts ${v.recipes.join(', ')}, which move${v.recipes.length === 1 ? 's' : ''} a customer balance, and is not in the custodial-layer inventory`,
      detail: `INTAFACED holds no customer money at launch (OWNER 226). Record what the source reports instead, or, if this is the custodial layer kept for later, add it to ${INVENTORY_PATH} in a reviewed gate: change`,
    });
  }
  for (const s of stale)
    out.notices.push(`${s.file}: the inventory lists ${s.recipes.join(', ')}, no longer posted there (remove the row)`);
  const n = Object.keys(found).length;
  out.summary = `${n} custodial-layer posting site(s) match the inventory; switch default off`;
  return out;
}
