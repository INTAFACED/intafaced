/**
 * CUSTODY SCAN, CHECK 4 — the custody switch (OWNER 226: INTAFACED launches holding no customer money).
 *
 * The custodial layer stays built and is switched off at launch. svc-ledger refuses a customer-balance post while
 * `LEDGER_CUSTODY_LAYER` is off (its default). This check is the static half: with the switch's default off, every
 * source file that posts a recipe moving a customer balance must be a site the reviewed inventory names as part of the
 * custodial layer (`tooling/ci/custody-layer-inventory.json`). A NEW customer-balance posting anywhere in services/,
 * packages/ or a Rust service's crate (`crates/svc-*`, svc-ledger itself excepted) fails the scan until a reviewed change adds it to the inventory, which says, in review, "this is custody".
 *
 * It fails closed:
 *   · the switch's default is read from source (ledger-client's parser, the svc-ledger crate's env, boot and posting)
 *     and must be off;
 *   · the inventory's list of customer-balance recipes is pinned to the ledger's own recipe samples by
 *     packages/ledger-client/src/gate/custody-layer-inventory.test.ts, so a new recipe that touches a customer account cannot be
 *     left off the list;
 *   · a dynamic recipe call (`recipes[name](...)`) counts as a posting of every customer recipe (`*`).
 *
 * WHAT IT DOES NOT SEE (named, not hidden): a recipe reached through a wrapper or re-export in another file (that file
 * is the site, and packages/ is walked), or through computed access other than `recipes[...]`.
 * tooling/ and apps/ are not walked: tooling posts only against the TEST stack and apps never post. Test files and
 * `__tests__/` folders are skipped; a `testing/` folder is walked, since shipping code can live there.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const INVENTORY_PATH = 'tooling/ci/custody-layer-inventory.json';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', 'drizzle', 'target', '.git', '__tests__']);
const TEST_FILE = /\.(test|spec|testkit|fixture|fixtures)\.[cm]?tsx?$|\.pw\.[cm]?[jt]s$/;
const LEDGER_CLIENT_SRC = 'packages/ledger-client/';

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

  // const { deposit, rewardPay: pay } = recipes;   and   const r = recipes;
  for (const obj of [...recipeObjects]) {
    const o = obj.replace(/\./g, '\\s*\\.\\s*');
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${o}\\b`, 'g'))) {
      for (const raw of m[1].split(',')) {
        const [imported, local] = raw.split(':').map((s) => s.trim());
        if (imported && customer.has(imported)) named.set(local || imported, imported);
      }
    }
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${o}\\s*;`, 'g'))) recipeObjects.add(m[1]);
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

/**
 * The functions a Rust file that sends through its client's `.post_recipe(` defines to post a recipe it is handed: each
 * `fn <name>(` with a `recipe: &str` parameter (svc-bank's `loans::service::post`). Pure.
 */
export function rustRecipeWrappers(text) {
  const live = text.split('#[cfg(test)]')[0] ?? '';
  if (!/\.post_recipe\(/.test(live)) return [];
  return [...live.matchAll(/\bfn\s+([a-z_][a-z0-9_]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g)]
    .filter((m) => /\brecipe\s*:\s*&str\b/.test(m[2]))
    .map((m) => m[1]);
}

/**
 * The customer-balance recipes a Rust service's source posts: a file that sends through its client's `.post_recipe(`
 * posts each recipe a string literal names, as the ledger's caller allowlist test reads it, and each `Recipe::<Name>`
 * variant it builds (`Recipe::FeeCharge` is `feeCharge`). A file that calls one of its crate's recipe wrappers
 * (`rustRecipeWrappers`) posts each recipe a string literal names in that call's statement. Its `#[cfg(test)]` module is
 * not production. Pure, so the test can plant one.
 */
export function rustCustomerRecipeCalls(text, customerRecipes, wrappers = []) {
  const live = text.split('#[cfg(test)]')[0] ?? '';
  const customer = new Set(customerRecipes);
  const literals = (t) => [...t.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
  let named = [];
  if (/\.post_recipe\(/.test(live)) {
    const variant = [...live.matchAll(/\bRecipe::([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1][0].toLowerCase() + m[1].slice(1));
    named = [...literals(live), ...variant];
  } else if (wrappers.length > 0) {
    const call = new RegExp(`(?<![.\\w])(?:${wrappers.join('|')})\\s*\\(([^;]*)`, 'g');
    named = [...live.matchAll(call)].flatMap((m) => literals(m[1]));
  }
  return [...new Set(named.filter((n) => customer.has(n)))].sort();
}

function* walkRust(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkRust(full);
    else if (name.endsWith('.rs')) yield full;
  }
}

/** Every customer-balance posting site under services/, packages/ (ledger-client itself excluded) and each Rust service's `src` (svc-ledger excluded: it is the book). */
export function customerPostingSites(root, customerRecipes) {
  const sites = {};
  for (const top of ['services', 'packages']) {
    for (const file of walk(join(root, top))) {
      const rel = relative(root, file).split(sep).join('/');
      if (rel.startsWith(LEDGER_CLIENT_SRC) || TEST_FILE.test(rel)) continue;
      const calls = customerRecipeCalls(readFileSync(file, 'utf8'), customerRecipes);
      if (calls.length > 0) sites[rel] = calls;
    }
  }
  const crates = join(root, 'crates');
  for (const crate of existsSync(crates) ? readdirSync(crates) : []) {
    if (!crate.startsWith('svc-') || crate === 'svc-ledger') continue;
    const files = [...walkRust(join(crates, crate, 'src'))].map((file) => [file, readFileSync(file, 'utf8')]);
    const wrappers = [...new Set(files.flatMap(([, text]) => rustRecipeWrappers(text)))];
    for (const [file, text] of files) {
      const rel = relative(root, file).split(sep).join('/');
      const calls = rustCustomerRecipeCalls(text, customerRecipes, wrappers);
      if (calls.length > 0) sites[rel] = calls;
    }
  }
  return sites;
}

/**
 * Is the switch's default off? Read from source, so the check can't be satisfied by an inventory alone.
 * Returns a list of problems; empty means off by default everywhere it is set: the parser, the svc-ledger crate's env,
 * boot and posting, and the compose file staging deploys.
 */
export function switchDefaultProblems(root) {
  const problems = [];
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
  const parser = read('packages/ledger-client/src/custody-layer.ts');
  if (!parser || !/raw\.trim\(\)\s*===\s*''\)\s*return\s*'off'/.test(parser)) {
    problems.push("packages/ledger-client/src/custody-layer.ts: parseCustodyLayer must read unset or blank as 'off'");
  }
  // svc-ledger is the Rust crate: the env reads the switch through parse_custody_layer, which reads blank as off.
  const env = read('crates/svc-ledger/src/env.rs');
  if (!env || !/parse_custody_layer\(o\.f\.get\("LEDGER_CUSTODY_LAYER"\)\)/.test(env)) {
    problems.push('crates/svc-ledger/src/env.rs: LEDGER_CUSTODY_LAYER must be parsed by parse_custody_layer');
  }
  const parseFn = env?.match(/pub fn parse_custody_layer\([\s\S]*?\n\}/)?.[0];
  if (!parseFn || !/is_empty\(\)\)\s*else\s*\{\s*return Ok\("off"\);/.test(parseFn)) {
    problems.push('crates/svc-ledger/src/env.rs: parse_custody_layer must read unset or blank as "off"');
  }
  const main = read('crates/svc-ledger/src/main.rs');
  const onFromEnv = 'env\\.str\\("LEDGER_CUSTODY_LAYER"\\)\\s*==\\s*Some\\("on"\\)';
  if (!main || !new RegExp(`Posting::new\\(\\s*[^,]+,\\s*[^,]+,\\s*${onFromEnv}\\s*,`).test(main)) {
    problems.push('crates/svc-ledger/src/main.rs: posting must take the custody switch from env LEDGER_CUSTODY_LAYER');
  }
  if (!main || !new RegExp(`boot::assert_custody_layer_bootable\\(\\s*[^,]+,\\s*${onFromEnv}\\s*,?\\s*\\)`).test(main)) {
    problems.push('crates/svc-ledger/src/main.rs: boot must call boot::assert_custody_layer_bootable with the env switch');
  }
  // docker-compose.apps.yml is staging's deployment unit as well as `pnpm platform:up`.
  const compose = read('docker-compose.apps.yml');
  const composeLine = compose?.match(/^\s*LEDGER_CUSTODY_LAYER:\s*(.*)$/m)?.[1]?.trim();
  if (composeLine !== undefined && composeLine !== '${LEDGER_CUSTODY_LAYER:-off}' && composeLine !== '${LEDGER_CUSTODY_LAYER}') {
    problems.push('docker-compose.apps.yml: LEDGER_CUSTODY_LAYER must default to off (it is the staging deployment unit)');
  }
  const posting = read('crates/svc-ledger/src/posting/mod.rs');
  if (!posting || !/if !p\.custody_layer_on && r\.moves_customer_balance\(\)/.test(posting)) {
    problems.push('crates/svc-ledger/src/posting/mod.rs: book must refuse a customer-balance post while the layer is off');
  }
  return problems;
}

/**
 * Compare the sites found with the inventory. A new site, or a new recipe at a listed site, is a violation. So is a
 * stale row: a listed recipe a file no longer posts would otherwise keep permission to come back unreviewed.
 */
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
  for (const s of stale) {
    out.violations.push({
      check: 'custody-layer-inventory-stale',
      file: s.file,
      reason: `the inventory lists ${s.recipes.join(', ')} for this file, which no longer posts ${s.recipes.length === 1 ? 'it' : 'them'}`,
      detail: `Remove the row from ${INVENTORY_PATH}: a stale row would let that posting come back without review`,
    });
  }
  const n = Object.keys(found).length;
  out.summary = `${n} custodial-layer posting site(s) match the inventory; switch default off`;
  return out;
}
