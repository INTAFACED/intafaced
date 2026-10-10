#!/usr/bin/env node
/**
 * Dual-book door-kill registration scan (Plan P2-4 · Spec DB-2 · Architect A1).
 *
 * Proves the Spring money-door interceptor exists and is registered on the five
 * money-facing ApplicationConfig modules (admin, ucenter-api, otc-api, exchange-api, exchange).
 *
 * Does not prove a running JVM — that is residual until a Spring boot smoke exists.
 * Combined with DAO no-ops + service throws + vendor-java-money-scan, this is the
 * "at the door" wiring check CI can enforce without Java runtime.
 *
 * Exit 0 = wired. Exit 1 = missing class or registration.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const VENDOR = join(ROOT, 'vendor');

if (!statSync(VENDOR, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('✖ dual-book-door-scan: vendor/ tree missing — dual-book door cannot be verified');
  process.exit(1);
}

function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === '.git') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, pred, out);
    else if (pred(name, p)) out.push(p);
  }
  return out;
}

const interceptorFiles = walk(VENDOR, (name) => name === 'DualBookMoneyDoorInterceptor.java');
if (interceptorFiles.length !== 1) {
  console.error(`✖ dual-book-door-scan: expected exactly one DualBookMoneyDoorInterceptor.java, found ${interceptorFiles.length}`);
  process.exit(1);
}

// Comment-stripped code only. A comment that mentions withdraw/apply and 410 is
// not a door, and neither is an unanchored 410 or one inventory fragment. The
// no-op must carry SC_GONE and BLOCKED_URI_FRAGMENTS as code.
const interceptorSrc = stripComments(readFileSync(interceptorFiles[0], 'utf8'));
if (!/\bSC_GONE\b/.test(interceptorSrc)) {
  console.error('✖ dual-book-door-scan: interceptor must refuse with HTTP 410 Gone');
  process.exit(1);
}
if (!/\bBLOCKED_URI_FRAGMENTS\b/.test(interceptorSrc)) {
  console.error('✖ dual-book-door-scan: interceptor missing inventory-driven blocked path fragments');
  process.exit(1);
}

/**
 * THE REGISTRATION, not the word.
 *
 * This check used to be `text.includes('DualBookMoneyDoorInterceptor')` over the
 * whole file. Every one of these configs also carries an `import` line naming
 * the interceptor class — so the import ALONE satisfied it. Proved by taking the
 * door off its hinges in memory and re-running the old check:
 *
 *     registration line still present after gutting?               false
 *     old check  text.includes("DualBookMoneyDoorInterceptor") ->  true
 *     what still satisfied it: the unused import line, nothing else
 *
 * Delete the real `registry.addInterceptor(…).addPathPatterns("/**")` line,
 * leave the import — which Java compiles happily as unused — and the gate still
 * printed "✓ interceptor + registration on admin, ucenter-api, otc-api,
 * exchange-api."
 *
 * The dual-book door is the boundary between the vendored exchange's own wallet
 * tables and the sovereign ledger, which makes it the most important guard in
 * the system, and it was being proved by an unused import line.
 *
 * `.addPathPatterns("/**")` is required rather than optional: an interceptor
 * registered against a narrower path set is a door with a gap, and the gap is
 * exactly where a money controller nobody remembered would sit.
 *
 * Comments are stripped first for the reason the kill-switch gate already
 * documents — a commented-out registration reads as a registration to a naive
 * matcher, and that is the same class of defect this fix is closing.
 */
const REGISTRATION =
  /registry\s*\.\s*addInterceptor\s*\(\s*new\s+DualBookMoneyDoorInterceptor\s*\([^)]*\)\s*\)\s*\.\s*addPathPatterns\s*\(\s*"\/\*\*"\s*\)/;

/**
 * Block and line comments, so commented-out code cannot satisfy a check.
 *
 * STRING LITERALS ARE MASKED FIRST, and that is not defensive tidiness — the
 * naive version broke this exact gate on its first run. The thing being matched
 * is `.addPathPatterns("/**")`, and `"/**"` opens a block comment as far as a
 * plain regex is concerned: the stripper ate from there to the next `*​/` in the
 * file and took the registration with it, so all four configs reported as
 * unregistered. A comment stripper that cannot tell a comment from a path
 * pattern is the same class of defect as an import that passes for a
 * registration.
 */
function stripComments(source) {
  const literals = [];
  const masked = source.replace(/"(?:\\.|[^"\\])*"/g, (s) => `"\u0000${literals.push(s) - 1}\u0000"`);
  const decommented = masked.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return decommented.replace(/"\u0000(\d+)\u0000"/g, (_, i) => literals[Number(i)]);
}

/** Apps that host money controllers per P2-1 inventory. */
const REQUIRED_CONFIG_MARKERS = [
  { id: 'admin', pathIncludes: ['admin', 'ApplicationConfig.java'] },
  { id: 'ucenter-api', pathIncludes: ['ucenter-api', 'ApplicationConfig.java'] },
  { id: 'otc-api', pathIncludes: ['otc-api', 'ApplicationConfig.java'] },
  { id: 'exchange-api', pathIncludes: ['exchange-api', 'ApplicationConfig.java'] },
  // Matching process hosts MonitorController paths that publish settlement Kafka.
  // Path must not match exchange-api: use the module directory boundary.
  // Segments stay OS-agnostic — Windows worktrees use `\` and must not miss the door.
  { id: 'exchange', pathIncludes: ['00_framework', 'exchange', 'ApplicationConfig.java'] },
];

/** Normalize for segment matching so Linux CI and Windows worktrees agree. */
function pathSegs(p) {
  return p.split(/[/\\]+/);
}

function pathHasOrderedSegments(p, segs) {
  const parts = pathSegs(p);
  // Require `exchange` as its own segment (not a prefix of `exchange-api`).
  return segs.every((seg) => {
    if (seg === 'ApplicationConfig.java') return parts[parts.length - 1] === seg;
    if (seg === 'exchange') return parts.includes('exchange') && !parts.includes('exchange-api');
    return parts.includes(seg);
  });
}

const appConfigs = walk(VENDOR, (name, p) => name === 'ApplicationConfig.java');
const failures = [];

for (const marker of REQUIRED_CONFIG_MARKERS) {
  const match = appConfigs.find((p) => pathHasOrderedSegments(p, marker.pathIncludes));
  if (!match) {
    failures.push(`no ApplicationConfig.java found for ${marker.id}`);
    continue;
  }
  const text = stripComments(readFileSync(match, 'utf8'));
  if (!REGISTRATION.test(text)) {
    failures.push(
      `${relative(ROOT, match).replace(/\\/g, '/')} does not REGISTER DualBookMoneyDoorInterceptor ` +
        `(need registry.addInterceptor(new DualBookMoneyDoorInterceptor()).addPathPatterns("/**"))`,
    );
  }
}

if (failures.length) {
  console.error('✖ dual-book-door-scan failed — door-kill not wired:\n');
  for (const f of failures) console.error(`  · ${f}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ dual-book-door-scan clean — interceptor + registration on ${REQUIRED_CONFIG_MARKERS.map((m) => m.id).join(', ')}`);
