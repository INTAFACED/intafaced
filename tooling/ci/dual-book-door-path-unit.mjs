#!/usr/bin/env node
/**
 * Dual-book door path-matcher unit (no JVM).
 *
 * Parses DualBookMoneyDoorInterceptor.java BLOCKED_URI_FRAGMENTS and asserts:
 *   1. Known money-controller URIs are refused (substring match, case-insensitive)
 *   2. Benign URIs are allowed
 *   3. Fragment count stays above inventory floor (regression guard)
 *
 * Complements scan:dual-book-door (wiring) without requiring Spring boot.
 * Spec DB-2 acceptance residual: full JVM 410 smoke still needs a running Java
 * process (H-OR-JAVA / ops) — this proves the **path table logic** stays intact.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VENDOR = join(ROOT, 'vendor');

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

/** Block and line comments. Strings are masked first so a path cannot look like a comment. */
function stripJavaComments(source) {
  const literals = [];
  const masked = source.replace(/"(?:\\.|[^"\\])*"/g, (s) => `"\u0000${literals.push(s) - 1}\u0000"`);
  const decommented = masked.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return decommented.replace(/"\u0000(\d+)\u0000"/g, (_, i) => literals[Number(i)]);
}

function maskJavaStrings(source) {
  return source.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function braceBody(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

function methodBodies(source, signatureRe) {
  const bodies = [];
  for (const m of source.matchAll(signatureRe)) {
    const open = m.index + m[0].length - 1;
    if (source[open] !== '{') continue;
    const body = braceBody(source, open);
    if (body != null) bodies.push(body);
  }
  return bodies;
}

/** Text inside the call whose '(' is at openIndex. A [^)]* capture stops inside getRequestURI(). */
function callArg(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') break;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** Locals assigned from pathForMatch of the request URI, not a constant or a helper argument. */
function decodedRequestNames(preBody) {
  const uriLocals = new Set();
  for (const m of preBody.matchAll(
    /\b(?:final\s+)?String\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*request\s*\.\s*getRequestURI\s*\(\s*\)/g,
  )) {
    uriLocals.add(m[1]);
  }
  const decoded = [];
  const head = /\b(?:final\s+)?String\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*pathForMatch\s*\(/g;
  for (const m of preBody.matchAll(head)) {
    const open = m.index + m[0].length - 1;
    if (preBody[open] !== '(') continue;
    const arg = callArg(preBody, open);
    if (arg == null) continue;
    const trimmed = arg.trim();
    if (/^request\s*\.\s*getRequestURI\s*\(\s*\)$/.test(trimmed) || uriLocals.has(trimmed)) decoded.push(m[1]);
  }
  return decoded;
}

function preHandleConsultsBlockedOnDecodedPath(preBody) {
  const decodedNames = decodedRequestNames(preBody);
  if (decodedNames.length === 0) return false;
  const head =
    /for\s*\(\s*(?:final\s+)?String\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*BLOCKED_URI_FRAGMENTS\s*\)\s*\{/g;
  for (const m of preBody.matchAll(head)) {
    const open = m.index + m[0].length - 1;
    const body = braceBody(preBody, open);
    if (body == null) continue;
    const frag = m[1];
    for (const name of decodedNames) {
      if (new RegExp(`\\b${name}\\s*\\.\\s*contains\\s*\\(\\s*${frag}\\b`).test(body)) return true;
    }
  }
  return false;
}

const files = walk(VENDOR, (n) => n === 'DualBookMoneyDoorInterceptor.java');
if (files.length !== 1) {
  console.error(`✖ dual-book-door-path-unit: expected 1 interceptor, found ${files.length}`);
  process.exit(1);
}

const src = readFileSync(files[0], 'utf8');

// Bind the door to preHandle's body. A comment, javadoc sample, or unused helper
// can carry pathForMatch / URLDecoder.decode / `path = pathForMatch(` while
// preHandle still matches getRequestURI() and encoded money paths skip the door.
const javaCode = maskJavaStrings(stripJavaComments(src));
const matcherBodies = methodBodies(
  javaCode,
  /\bstatic\s+String\s+pathForMatch\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{/g,
);
if (matcherBodies.length === 0 || matcherBodies.some((body) => !/URLDecoder\s*\.\s*decode\s*\(/.test(body))) {
  console.error(
    '✖ dual-book-door-path-unit: static pathForMatch(String) must URLDecoder.decode the request path',
  );
  process.exit(1);
}
const preBodies = methodBodies(
  javaCode,
  /\bboolean\s+preHandle\s*\(\s*HttpServletRequest\b[^)]*\)\s*(?:throws\s+[^{]+)?\{/g,
);
if (preBodies.length === 0 || preBodies.some((body) => !preHandleConsultsBlockedOnDecodedPath(body))) {
  console.error(
    '✖ dual-book-door-path-unit: preHandle must consult BLOCKED_URI_FRAGMENTS on pathForMatch(request URI)',
  );
  process.exit(1);
}

const block = src.match(/BLOCKED_URI_FRAGMENTS\s*=\s*Arrays\.asList\(([\s\S]*?)\);/);
if (!block) {
  console.error('✖ dual-book-door-path-unit: could not parse BLOCKED_URI_FRAGMENTS');
  process.exit(1);
}

const fragments = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
// Floor is the live inventory count on tip when this unit last tightened (2026-08-09).
// A lower floor silently green-lights deleting money fragments (mega-audit residual).
const FRAGMENT_FLOOR = 43;
if (fragments.length < FRAGMENT_FLOOR) {
  console.error(
    `✖ dual-book-door-path-unit: fragment floor ${FRAGMENT_FLOOR} not met (found ${fragments.length}) — Spec DB-2 inventory class`,
  );
  process.exit(1);
}

/** Mirror DualBookMoneyDoorInterceptor.pathForMatch — decode then lowercase. */
function pathForMatch(rawUri) {
  if (rawUri == null) return null;
  let decoded = rawUri;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.toLowerCase();
}

function wouldBlock(uri) {
  const path = pathForMatch(uri);
  if (path == null) return false;
  return fragments.some((f) => path.includes(f.toLowerCase()));
}

const mustBlock = [
  '/admin/member/member-wallet/recharge',
  '/uc/legal-wallet-recharge/apply',
  '/uc/withdraw/apply',
  '/otc/order/buy',
  '/exchange/order/add',
  '/admin/finance/withdraw-record/audit-pass',
  '/uc/redenvelope/receive',
  '/admin/system/dividend/start',
  '/uc/promotion/promotioncard/exchangecard',
  '/monitor/reset-trader',
  '/monitor/start-trader',
  // percent-encoding must not skip the door (Spring routes on decoded path)
  '/admin/member/member-wallet/recharg%65',
  '/uc/withdraw/appl%79',
  '/otc/order/bu%79',
  '/uc/promotio%6e/promotioncard/exchangecard',
  '/monitor/reset-trade%72',
];

const mustAllow = ['/uc/member/login', '/market/symbol-thumb', '/health', '/actuator/health', '/uc/asset/wallet'];

const fails = [];
for (const u of mustBlock) {
  if (!wouldBlock(u)) fails.push(`should block ${u}`);
}
for (const u of mustAllow) {
  if (wouldBlock(u)) fails.push(`should allow ${u}`);
}

if (fails.length) {
  console.error('✖ dual-book-door-path-unit failed:\n' + fails.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}

console.log(
  `✓ dual-book-door-path-unit clean — ${fragments.length} fragments, ${mustBlock.length} block + ${mustAllow.length} allow fixtures`,
);
