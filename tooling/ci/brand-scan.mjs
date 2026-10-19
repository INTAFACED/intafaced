#!/usr/bin/env node
/**
 * BRAND SCAN — Doctrine §0.7, enforced.
 *
 *   "The onboarding intelligence is the GMaster Neural Engine consumed as an
 *    internal service. User-facing copy references only: Identity Blueprint,
 *    Sovereign Intelligence, Neural Engine. No third-party system names
 *    anywhere in UI, API responses, or docs shipped to users."
 *
 * This scans everything that can reach a user — components, i18n catalogues,
 * API response literals, public docs — for forbidden names.
 *
 * The vendor name is forbidden EVERYWHERE, including inside service code. There
 * is no "internal code may name it" exemption: `services/svc-blueprint/src` is
 * not allowlisted and never has been. The engine is reached through
 * `BLUEPRINT_ENGINE_URL` and a `NeuralEngineClient`, which is enough to call it
 * without naming it.
 *
 * (This comment previously claimed the opposite — that svc-blueprint's source
 * was allowed to reference the vendor. It was never true, and the ALLOWLIST
 * below proves it. A comment that invites you to trust a permission you do not
 * have is worse than no comment. Caught while building svc-blueprint.)
 *
 * The allowlist is deliberately narrow and every entry carries a reason.
 *
 * Exit 0 = clean. Exit 1 = a name would have shipped.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

/**
 * Internal AFK paste packs name coding-agent products so operators open the
 * right tool. That is not user-facing copy. Wave directories used to be
 * allowlisted one-by-one (`docs/paste-w6`, then WAVE-7 reds main — #1471 class).
 * Match the wave pattern once so every wave does not re-break the gate.
 *
 * Product surfaces (apps/, services/, packages/) are never matched here.
 */
export function isInternalPastePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  const p = relPath.replace(/\\/g, '/');
  // docs/paste-w6, docs/paste-w7/L09.md, docs/paste-w10/...
  if (/^docs\/paste-w\d+(\/|$)/.test(p)) return true;
  // docs/PASTE-BUILD-WAVE-6-2026-08-09.md (removed), WAVE-7, …
  if (/^docs\/PASTE-BUILD-WAVE-\d+/.test(p)) return true;
  // docs/PASTE-W6-AUDIT-…, PASTE-W7-DEPTH-…
  if (/^docs\/PASTE-W\d+/.test(p)) return true;
  // durable home (pre-authorised; empty or wave subdirs)
  if (p === 'docs/paste' || p.startsWith('docs/paste/')) return true;
  return false;
}

/**
 * Names that must never appear in shipped copy. Extend as partners are added
 * (§0.4 adapters: rail and issuer names are internal identifiers, not brands).
 */
const FORBIDDEN = [
  { pattern: /\bGMaster\b/i, reason: 'engine vendor name — say "Neural Engine"' },
  { pattern: /\bG-?Master\s*Neural\b/i, reason: 'engine vendor name' },
  {
    pattern: /\bFincept\b/i,
    reason: 'licensed terminal vendor — the desktop client ships fully rebranded (docs/TERMINAL_INTEGRATION.md (removed) §8)',
  },
  { pattern: /\bSettleTX\b/i, reason: 'rail partner name' },
  { pattern: /\bPayKwik\b/i, reason: 'rail partner name' },
  { pattern: /\bNTG\b/, reason: 'rail partner name' },
  { pattern: /\bAnthropic\b/i, reason: 'model provider — agents are "Sovereign Intelligence"' },
  // NOT `CLAUDE.md`. That filename is mandated by this repo's own root
  // instructions and is cited by name in AGENTS.md, the agent protocol, and
  // every coordination doc — so the bare pattern fired on documents whose only
  // offence was naming a file we require. A false positive that recurs on every
  // new doc is a gate people learn to route around, and that costs more than the
  // rule protects. The provider name on its own is still forbidden.
  // All-caps `CLAUDE` is the FILENAME this repo's own root instructions mandate,
  // and it is cited constantly — `CLAUDE.md`, and bare in slash-lists like
  // "AGENTS/CLAUDE/protocol". The bare pattern fired on documents whose only
  // offence was naming a file we require, which made this gate red on main twice
  // in two days. A false positive that recurs on every new doc is a gate people
  // learn to route around, and that costs more than the rule protects.
  //
  // The distinction is reliable because the two are written differently: the file
  // is CLAUDE, the model is Claude. Every other casing stays forbidden.
  // CASE-SENSITIVE ON PURPOSE, and the `i` flag must not come back.
  //
  // All-caps `CLAUDE` is the FILENAME this repo's own root instructions mandate.
  // It is cited constantly — `CLAUDE.md`, and bare in slash-lists like
  // "AGENTS/CLAUDE/protocol". The case-insensitive pattern fired on documents
  // whose only offence was naming a file we require, and it turned main red twice
  // in two days. A false positive that recurs on every new doc is a gate people
  // learn to route around, which costs more than the rule protects.
  //
  // The distinction is reliable because the two are spelled differently: the file
  // is CLAUDE, the model is Claude. Written as alternation rather than a negative
  // lookahead — `(?!CLAUDE\b)…/i` looks correct and is not: under `i` the
  // lookahead matches every casing too, so it excludes everything and the rule
  // silently stops firing. That version was written, tested, and caught here.
  { pattern: /\b(?:Claude|claude)\b/, reason: 'model provider' },
  { pattern: /\bOpenAI\b/i, reason: 'model provider' },
  { pattern: /\bGPT-\d/i, reason: 'model provider' },

  // Third-party exchange provenance. These names carry no product meaning for
  // us, so the only route into the tree is somebody copying in another
  // project's source — which is precisely the moment a demo domain or a
  // stranger's contact address ships to a customer. Added pre-emptively: as of
  // this commit the repo contains none of them, and a guard that costs nothing
  // is worth more than noticing late that support mail points at a person who
  // has never heard of us.
  { pattern: /\bbizzan\b/i, reason: 'third-party exchange vendor identity — also covers BizzanExchange, com.bizzan, bizzan.com' },
  { pattern: /\bbitrade\b/i, reason: 'third-party exchange vendor identity (upstream module prefix)' },
  { pattern: /\bcoinexchange\b/i, reason: 'third-party exchange vendor identity' },
  {
    pattern: /\b(?:877070886|837385225|220806216)@qq\.com\b/i,
    reason: 'upstream author contact address — never ours to publish or point users at',
  },
];

/** Directories never scanned. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'drizzle',
  '.docker-data',
  // Third-party source we redistribute rather than author. Its package names,
  // groupIds and entity→table mappings are load-bearing — renaming them to
  // strip a vendor's identity breaks the build it came with. The rule that
  // still applies is §0.7 at the boundary: nothing from here may surface in
  // our UI, API responses or docs unrebranded, and the FORBIDDEN entries above
  // are what catch it if it tries. Note the trade-off this makes: our own code
  // would go unscanned if it were ever parked under a `vendor/` directory.
  // Don't do that.
  //
  // 2026-08-03 / D26-P2-14: deleting this entry is still the wrong fix —
  // measured, a blind walk of `vendor/` takes the repo-wide result from 0
  // findings to thousands, almost all load-bearing Java package/groupId lines
  // that are not user-facing copy. The product surfaces inside vendor ARE
  // scanned: see `collectVendorProductFiles()` below (Vue project roots,
  // its six invitation-imported files, and Java
  // `src/main/resources`).
  // `tooling/ci/shell-brand-scan.mjs` remains the relaxed-boundary ratchet over
  // the vendored Java CORS surface so welded identifiers cannot hide behind `\b`.
  'vendor',

  // Tool and package caches. Not our source, not in git, not in CI — but they
  // sit under the repo root, so a scan that walks by name alone opens them.
  '.pnpm-store',
  '.tools',
]);

/**
 * A directory carrying its own `.git` is a different checkout — a linked
 * worktree or a nested clone — not our source tree.
 *
 * This is the local-vs-CI drift `gates.mjs` exists to prevent, and it was
 * living inside the gate apparatus itself. CLAUDE.md non-negotiable #1 tells
 * every agent to work in a worktree, `pnpm wt` puts them under `.worktrees/`,
 * and nothing is gitignored from the scan's point of view because the scan
 * never asks git. Measured on 2026-08-07: 1491 of 1519 reported occurrences
 * were sibling worktrees — other agents' checkouts of this same file — so an
 * agent that obeyed non-negotiable #4 and ran `pnpm verify` saw a red that had
 * nothing to do with its work, halting before typecheck and all 48 test
 * packages ran. CI never saw it, because CI checks out one tree.
 *
 * Matching on `.git` rather than on the name `.worktrees` is deliberate: it
 * holds for a worktree parked anywhere, which is the case that produced the
 * false red in the first place.
 */
function isSeparateCheckout(dir) {
  return existsSync(join(dir, '.git'));
}

/**
 * Paths exempt from the scan, each with a reason. Anything added here is a
 * deliberate, reviewable decision — not a way around the rule.
 */
const ALLOWLIST = [
  { path: 'INTAFACED_DEFINITIVE_BUILD.md', reason: 'the build doctrine itself — internal, never shipped to users' },
  { path: join('tooling', 'ci', 'brand-scan.mjs'), reason: 'this file declares the forbidden names' },
  { path: join('tooling', 'agent-protocol'), reason: 'internal agent rules — not user-facing' },
  { path: 'README.md', reason: 'internal repo README' },
  { path: 'CONTRIBUTING.md', reason: 'internal contributor guide — names the agent tools we actually use' },
  { path: 'AGENTS.md', reason: 'internal agent brief — not shipped to users' },
  { path: '.github', reason: 'internal repo templates and workflows' },
  {
    path: join('docs', 'adr'),
    reason: 'internal architecture decision records — must be free to name upstream vendors so quarantine and rebrand scope stay auditable',
  },
  {
    path: join('docs', 'audit'),
    reason: 'internal audit work product; may cite vendor paths when describing CI/brand failures',
  },
  // Wave paste dirs (docs/paste-wN, PASTE-BUILD-WAVE-N*, PASTE-W*) and
  // docs/paste/** are covered by isInternalPastePath() — do not re-list each
  // wave here (that is how WAVE-7 re-redded main after #1471).
  // REMOVED 2026-08-05, both on the terms their own reasons set:
  //
  //   `tooling/scripts/swarm.mjs`      — existed because that file assembled the
  //     vendor token at runtime to get past this scan. The directory rename means
  //     the path is `vendor/upstream-exchange/...`, so the line is written plainly
  //     and the exemption has nothing left to cover.
  //   `docker-compose.apps.yml`        — "Remove once the vendor directory is
  //     renamed." It is renamed. A build context still must be a real directory on
  //     disk, and now that directory has a clean name.
  //
  // Both files are back under the scan with nothing to hide, which is the point of
  // the rename: fewer exemptions, not more. 36 further entries are now dead by the
  // same test and are deliberately NOT pruned here — mixing a policy tightening
  // into a 1,764-file move would make a red CI ambiguous. See the PR for the list.
  {
    path: join('docs', 'LICENCE-POSITION.md'),
    reason:
      'internal licence audit; must name the exact vendor paths and Maven groupIds an unlicensed component sits at, or an engineer cannot act on it without first asking which path was meant. Same rationale as TERMINAL_INTEGRATION.md (removed) and docs/adr. Not shipped to users. Remove this entry once the vendor directory and Java package root are renamed.',
  },
  {
    path: join('docs', 'A1.4-WALLET-SECRETS-PERIMETER-2026-07-30.md'),
    reason:
      'internal security work product (board item A1.4); names the exact module and file each committed credential sits in. A finding that says "a password in some properties file" is not actionable — the whole value of the document is that an engineer can go straight to the key and rotate it. Not shipped to users. Remove this entry once the vendor directory and Java package root are renamed.',
  },
  {
    path: join('docs', 'SECRET-ROTATION-READINESS-2026-08-03.md'),
    reason:
      'internal security work product; the owner action list for rotating what A1.4 found. Identical rationale to the A1.4 entry above and over the same file set: an owner cannot act on "a seed in some wallet module", so every item names the exact module, file and line. The document deliberately contains no secret VALUES — only locations — which is exactly what makes the paths load-bearing. Not shipped to users. Remove this entry once the vendor directory and Java package root are renamed.',
  },
  {
    path: join('tooling', 'ci', 'secret-scan.mjs'),
    reason:
      'its KNOWN_DISCLOSED register keys each finding by exact tracked path, and the scan FAILS on a register entry that no longer matches — so a paraphrased path would not merely be unhelpful, it would break the rule that stops the register rotting into an exemption list. Seven entries, each a real path plus line and check name, no values. The synthetic paths in secret-scan.mutation.mjs need no such exception and deliberately use none. Remove this entry once the Java package root is renamed.',
  },
  {
    path: join('docs', 'RUNBOOK-ETH-KEYSTORE-REENCRYPTION.md'),
    reason:
      'internal custody runbook; an operator following it must be able to copy the real module paths and MongoDB collection names verbatim. A runbook that paraphrases the path it wants you to act on is how the wrong directory gets re-encrypted. Not shipped to users. Remove this entry once the vendor directory and Java package root are renamed.',
  },
  {
    path: 'NOTICE',
    reason:
      'root third-party attribution record; an attribution that omits the upstream it attributes is a false legal statement, so this file must name upstreams verbatim. It has no file extension and so currently falls outside EXTENSIONS below — this entry is deliberate belt-and-braces, so that widening EXTENSIONS later cannot silently fail CI on the one file whose whole job is naming upstreams accurately.',
  },
  { path: 'CLAUDE.md', reason: 'internal agent instructions' },
  { path: '.claude', reason: 'internal tooling config' },
  // Stream A agent law / handoffs — name planner vs implementer roles and on-disk
  // shell paths so territory is enforceable. Not user-facing product copy.
  // D26-P2-14 — vendor product-surface allowlist. Prefer deleting the name in
  // the tree; these rows exist only where the hit is upstream attribution that
  // is not shipped to customers and must not force a FE craft edit under the
  // nitro-frontend-all lane.
];

/** Only these extensions can carry shipped copy. */
const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.json',
  '.md',
  '.mdx',
  '.html',
  '.css',
  '.yaml',
  '.yml',
  // D26-P2-14: Vue SFCs are the product shell's user-facing markup.
  '.vue',
  // Java resource catalogues / templates that can surface in API/HTML responses.
  '.properties',
  '.ftl',
  '.xml',
];

function isAllowlisted(relPath) {
  if (isInternalPastePath(relPath)) return true;
  return ALLOWLIST.some((entry) => relPath === entry.path || relPath.startsWith(entry.path + sep));
}

function selfTest() {
  const fails = [];
  const assert = (c, m) => {
    if (!c) fails.push(m);
  };

  // THE REGRESSION: each new wave used to re-red main until someone added a
  // one-off allowlist line (#1471 paste-w6; WAVE-7 was the next landmine).
  assert(isInternalPastePath('docs/paste-w7/L09.md') === true, 'paste-w7 child allowed');
  assert(isInternalPastePath('docs/paste-w6/L15.md') === true, 'paste-w6 child allowed');
  assert(isInternalPastePath('docs/PASTE-BUILD-WAVE-7-2026-08-09.md') === true, 'PASTE-BUILD-WAVE-7 allowed');
  assert(isInternalPastePath('docs/PASTE-W7-AUDIT-2026-08-09.md') === true, 'PASTE-W7 audit allowed');
  assert(isInternalPastePath('docs/paste/w8/L01.md') === true, 'durable docs/paste/ child allowed');
  // Product surfaces must never ride the paste pattern.
  assert(isInternalPastePath('apps/web/src/page.tsx') === false, 'apps not paste');
  assert(isInternalPastePath('services/svc-pay/src/x.ts') === false, 'services not paste');
  assert(isInternalPastePath('docs/START-HERE.md') === false, 'ordinary docs not paste');
  assert(isInternalPastePath('docs/paste-extra/nope.md') === false, 'paste-extra is not paste-wN');
  assert(isAllowlisted('docs/START-HERE.md') === false, 'ordinary doc not archive');

  // D26-P2-14: vendor product surfaces must be discoverable when the tree exists.
  // The old Vue customer site was deleted 2026-10-19; the modules apps/invitation bundles live in
  // apps/invitation/src/vendored and must be reached by the repo-wide walk.
  const vendorRoot = join(ROOT, 'vendor');
  {
    const posixPath = (f) => f.split(sep).join('/');
    const walked = [...walk(join(ROOT, 'apps', 'invitation', 'src', 'vendored'))].map(posixPath);
    assert(!SKIP_DIRS.has('vendored'), 'vendored must not be a skipped directory name');
    assert(
      walked.some((f) => f.endsWith('/vendored/assets/js/outreach-intake.js')) &&
        walked.some((f) => f.endsWith('/vendored/config/intafaced.js')),
      'apps/invitation/src/vendored must be walked by the repo-wide scan',
    );
  }
  if (existsSync(vendorRoot)) {
    const productFiles = collectVendorProductFiles();
    assert(productFiles.length > 0, 'vendor product-surface walk returned 0 files');
    const posixPath = (f) => f.split(sep).join('/');
    if (existsSync(join(vendorRoot, 'upstream-exchange', '04_Web_Admin'))) {
      assert(
        productFiles.some((f) => f.endsWith('.vue') && posixPath(f).includes('/04_Web_Admin/')),
        'staff console .vue files must still be walked',
      );
    }
  }

  if (fails.length) {
    console.error('brand-scan --self-test FAIL:');
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log('brand-scan --self-test OK');
  console.log('  fixture paste-wN / PASTE-BUILD-WAVE-N / docs/paste/** allowed; product surfaces not');
  console.log('  vendor Java resources discoverable; apps/invitation/src/vendored walked');
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun && process.argv.includes('--self-test')) selfTest();

/**
 * Vue shell project roots under `vendor/` — discovered, never hard-coded as a
 * single upstream path, so a directory rename does not blind this gate.
 *
 * A root is any directory holding a Vue entry pair: `App.vue`/`app.vue` beside
 * `main.js`. The scanned unit is the PROJECT root (parent of that directory),
 * matching `shell-brand-scan.mjs`, so package.json / README / config stay in
 * scope with the SFCs. Any Vue root found under vendor/ is walked.
 */
function findVendorShellProjectRoots(dir, out = [], depth = 0) {
  if (depth > 6 || !existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  const names = new Set(entries.map((n) => n.toLowerCase()));
  if (names.has('app.vue') && names.has('main.js')) {
    const projectRoot = resolve(dir, '..');
    out.push(projectRoot);
    return out;
  }
  for (const name of entries) {
    // Do not use SKIP_DIRS here — it contains `vendor` for the repo-wide walk.
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'target' || name === 'build' || name === '.docker-data') {
      continue;
    }
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) {
        if (isSeparateCheckout(full)) continue;
        findVendorShellProjectRoots(full, out, depth + 1);
      }
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/**
 * Files inside vendor that can reach a user without walking every Java
 * package line: Vue project trees (any root under vendor/), the six
 * invitation-imported modules, and `src/main/resources` catalogues.
 */
function collectVendorProductFiles() {
  const vendorRoot = join(ROOT, 'vendor');
  if (!existsSync(vendorRoot)) return [];

  const files = new Set();
  const shellSkip = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', 'drizzle', '.docker-data', 'target', 'build']);

  function* walkScoped(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (shellSkip.has(name)) continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (isSeparateCheckout(full)) continue;
        yield* walkScoped(full);
      } else if (EXTENSIONS.some((ext) => name.endsWith(ext))) {
        yield full;
      }
    }
  }

  for (const projectRoot of new Set(findVendorShellProjectRoots(vendorRoot))) {
    for (const file of walkScoped(projectRoot)) files.add(file);
  }

  /**
   * Java `src/main/resources` copy surfaces only.
   *
   * `application*.properties` / Spring wiring XML under vendor carry load-bearing
   * DB names, SMS signs and module prefixes — renaming them is a Java rebrand
   * mountain, not a gate-allowlist dump. This walk still opens every message
   * catalogue and template so a partner name cannot hide in response copy.
   */
  const JAVA_COPY_EXT = new Set(['.ftl', '.html', '.htm', '.md', '.mdx', '.json', '.yml', '.yaml', '.txt']);
  function isJavaCopyResource(name) {
    const lower = name.toLowerCase();
    if (/^application(\-.+)?\.properties$/.test(lower)) return false;
    if (/^bootstrap(\-.+)?\.(properties|ya?ml)$/.test(lower)) return false;
    if (/^logback/.test(lower)) return false;
    if (lower.endsWith('.properties')) return true; // messages_*.properties etc.
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return false;
    return JAVA_COPY_EXT.has(lower.slice(dot));
  }

  function walkJavaResources(dir, depth = 0) {
    if (depth > 10 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (shellSkip.has(name)) continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (isSeparateCheckout(full)) continue;
        if (name === 'resources' && dir.replace(/\\/g, '/').endsWith('src/main')) {
          for (const file of walkScoped(full)) {
            if (isJavaCopyResource(file.split(/[\\/]/).pop())) files.add(file);
          }
          continue;
        }
        walkJavaResources(full, depth + 1);
      }
    }
  }
  walkJavaResources(vendorRoot);

  return [...files];
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (isSeparateCheckout(full)) continue;
      yield* walk(full);
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext))) yield full;
  }
}

const violations = [];
let scanned = 0;
let vendorProductScanned = 0;

const seen = new Set();
function scanFile(file) {
  const abs = resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);
  const rel = relative(ROOT, abs);
  if (isAllowlisted(rel)) return;

  scanned++;
  const content = readFileSync(abs, 'utf8');
  const lines = content.split('\n');

  for (const { pattern, reason } of FORBIDDEN) {
    if (!pattern.test(content)) continue;
    lines.forEach((line, i) => {
      // Fresh regex per line: the shared one may carry lastIndex state.
      if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(line)) {
        violations.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120), reason });
      }
    });
  }
}

for (const file of walk(ROOT)) scanFile(file);

const vendorProductFiles = collectVendorProductFiles();
for (const file of vendorProductFiles) {
  const before = scanned;
  scanFile(file);
  if (scanned > before) vendorProductScanned++;
}

if (violations.length > 0) {
  console.error(`\n✖ BRAND SCAN FAILED — ${violations.length} occurrence(s) of a forbidden name (Doctrine §0.7)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.reason}\n`);
  }
  console.error('  User-facing copy says only: Identity Blueprint · Sovereign Intelligence · Neural Engine.\n');
  process.exit(1);
}

/**
 * A walk that read nothing is a failure, not a pass.
 *
 * This scan has printed `clean — N files` since it was written, and nobody has
 * ever had to ask what happens when N is 0 — because `walk` would throw on a
 * missing ROOT and CI would go red for a different reason. That is luck, not a
 * guard: an over-broad SKIP_DIRS entry, or an ALLOWLIST prefix that swallows
 * more than its author meant, produces `clean — 0 files, 0 forbidden names` and
 * a green tick, which is the single most confident-sounding wrong answer this
 * file can give. Four scans in this repo have already been caught reporting
 * clean about a tree they never opened.
 */
if (scanned === 0) {
  console.error('\n✖ BRAND SCAN FAILED — 0 files were read. NOTHING WAS SCANNED.');
  console.error('  This is not a clean repo; it is a scan that opened nothing. Check SKIP_DIRS,');
  console.error('  ALLOWLIST and EXTENSIONS — one of them is now matching everything.\n');
  process.exit(1);
}

// D26-P2-14: when vendor/ is present, the product-surface INCLUDE walk must
// actually open files. A green tick that only covers services/docs while the
// sole UI lives under vendor/ is the hole this gate closed once already.
if (existsSync(join(ROOT, 'vendor')) && vendorProductScanned === 0) {
  console.error('\n✖ BRAND SCAN FAILED — vendor/ is present but 0 vendor product-surface files were read.');
  console.error('  Vue project roots + Java src/main/resources must be in scope (D26-P2-14).');
  console.error('  Check collectVendorProductFiles() / findVendorShellProjectRoots() — discovery is blind.\n');
  process.exit(1);
}

// The count is qualified on purpose, and on the SAME line, because `gates.mjs`
// prints only the last non-empty line as a gate's summary — a caveat on a second
// line is a caveat nobody reads in CI.
console.log(
  `✓ brand-scan clean — ${scanned} files (incl. ${vendorProductScanned} vendor product-surface), 0 forbidden names (Doctrine §0.7)`,
);
