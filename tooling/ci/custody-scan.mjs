#!/usr/bin/env node
/**
 * CUSTODY SCAN — Doctrine §16.10, enforced.
 *
 *   "The custody boundary is drawn in code. An automated CI check asserts that
 *    no Protocol Plane service imports ledger-client write recipes and no
 *    contract grants platform keys withdrawal power over user funds.
 *    Provably non-custodial or it doesn't merge."
 *
 * Three checks:
 *   1. No Protocol Plane service imports the ledger's write surface. Reading
 *      balances is fine; posting transactions is what custody looks like.
 *   2. No contract under a Protocol Plane service exposes a platform-callable
 *      path that can move user funds (a heuristic scan over Solidity sources,
 *      reported as a hard failure so a human has to look).
 *   3. Vendor Java **runtime risk surface** is in the scan object (D26-P2-08).
 *      Dual-book rules are NOT restated here — this gate **composes**
 *      `vendor-java-money-scan.mjs` as the DB-4 successor and fails closed if
 *      that successor is missing, red, or reports zero Java files. Money-plane
 *      `src/main/java` plus committed classpath `*.jar` must still be openable
 *      (presence), or the object is unscanned theater.
 *
 * Exit 0 = provably non-custodial / runtime Java surface scanned. Exit 1 = the
 * boundary moved or Java was never opened.
 *
 * ── WHAT THIS GATE IS, AND WHAT IT IS NOT (read this before citing it) ─────
 *
 * Checks 1–2 are a PROTOCOL PLANE gate. They are routinely cited as if they
 * were a repo-wide custody check. They are not: they assert non-custody only
 * where non-custody is promised.
 *
 * COVERED (checks 1–2): the services whose `planes` is exactly ['protocol'] and
 * whose `custodial` is false — DERIVED from packages/config/src/modules.ts —
 * plus every .sol file underneath them and a root contracts/.
 *
 * COVERED (check 3 — D26-P2-08): the **runtime risk surface** in vendor Java.
 * Scan object = money-plane module `src/main/java` (can move value if they
 * boot) + committed classpath jars (presence) + the successor scan actually
 * executed. Dual-book SQL / DAO / JPA ratchet lives only in
 * `vendor-java-money-scan.mjs`. Forking those rules here is a third scanner
 * and is forbidden. Test sources, docs, and gitignored `target/*.jar` stay
 * outside this object — a source scan of unbuilt trees is not a runtime claim
 * (ADR 2026-08-04).
 *
 * NOT COVERED, deliberately:
 *   · The other services under services/, including every custodial one.
 *     svc-ledger, svc-pay, svc-bank and svc-trade hold value ON PURPOSE, as
 *     svc-bridge will (§17.3). Checks 1–2 assert non-custody only where
 *     non-custody is promised; asserting it everywhere would assert a
 *     falsehood.
 *   · packages/ and apps/ — walked by neither Protocol Plane check.
 *   · Restating the dual-book call-site ratchet — that is the successor file.
 *
 * History: an earlier WIP bolted the full dual-book ratchet onto this file and
 * was correctly split out (DB-4 successor). #1748 re-opened Java here by
 * copying live-write regexes — a third scanner. This file now composes the
 * successor instead, so `pnpm scan:custody` cannot print clean while Java
 * money/custody is unscanned, and cannot drift from vendor-java-money-scan.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SERVICES = join(ROOT, 'services');
const VENDOR = join(ROOT, 'vendor');
const MODULES_TS = join(ROOT, 'packages', 'config', 'src', 'modules.ts');

/**
 * Protocol Plane services, DERIVED from packages/config/src/modules.ts.
 *
 * This list used to be a hardcoded array. It was accurate — and it was still a
 * latent hole, because accuracy at the moment of writing is not the property a
 * gate needs. Adding a Protocol Plane module to the registry would not have
 * armed this scan until somebody separately remembered to edit the array here,
 * and the failure of that memory is silent: the scan keeps printing ✓ while
 * walking a set that no longer matches the registry it claims to mirror. A gate
 * that reports green over a service it never opened is worse than no gate.
 *
 * So it is read from the registry instead. `modules.ts` is TypeScript and this
 * is a plain .mjs run by node with no build step, so it is parsed as text
 * rather than imported. That is a real constraint, not a shortcut: the parse
 * therefore FAILS CLOSED. Zero Protocol Plane modules is a failure. So is a
 * partial parse: one entry in the service-then-planes-then-custodial shape
 * must not let a protocol service in another shape drop out while this scan
 * prints clean. The old single-quoted, order-locked regex did that.
 *
 * svc-bridge is excluded by the rule itself, not by a special case: its
 * `planes` is ['fiat','protocol'] and its `custodial` is true. It is the one
 * seam that debits the ledger and credits the chain, custodial by design
 * (§17.3), and the registry already says so.
 */
function scanString(source, i) {
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let j = i + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    // A template expression is not a registry literal. Refuse it.
    if (quote === '`' && c === '$' && source[j + 1] === '{') return null;
    if (c === '\n' && quote !== '`') return null;
    if (c === quote) return j + 1;
    j++;
  }
  return null;
}

function scanPastTrivia(source, i) {
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

function matchBracket(source, openIndex, open, close) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = scanString(source, i);
      if (end === null) return -1;
      i = end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function identContinues(source, index) {
  const c = source[index];
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

function skipUntilAssign(source, i) {
  let angle = 0;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = scanString(source, i);
      if (end === null) return -1;
      i = end;
      continue;
    }
    if (c === '=' && angle === 0 && brace === 0 && paren === 0 && bracket === 0) {
      if (n === '>') {
        i += 2;
        continue;
      }
      return i;
    }
    if (c === '<') angle++;
    else if (c === '>' && angle > 0) angle--;
    else if (c === '{') brace++;
    else if (c === '}') {
      if (brace === 0) return -1;
      brace--;
    } else if (c === '(') paren++;
    else if (c === ')') {
      if (paren === 0) return -1;
      paren--;
    } else if (c === '[') bracket++;
    else if (c === ']') {
      if (bracket === 0) return -1;
      bracket--;
    }
    i++;
  }
  return -1;
}

/** The object assigned to `export const MODULES`, comments and strings skipped. */
function findModulesBody(source) {
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return { error: 'unterminated comment before MODULES' };
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = scanString(source, i);
      if (end === null) return { error: 'unterminated string before MODULES' };
      i = end;
      continue;
    }
    const atExport = source.startsWith('export', i) && !identContinues(source, i + 6) && (i === 0 || !identContinues(source, i - 1));
    if (atExport) {
      let j = scanPastTrivia(source, i + 6);
      if (j < 0) return { error: 'unterminated comment before MODULES' };
      if (source.startsWith('const', j) && !identContinues(source, j + 5)) {
        j = scanPastTrivia(source, j + 5);
        if (j < 0) return { error: 'unterminated comment before MODULES' };
        if (source.startsWith('MODULES', j) && !identContinues(source, j + 7)) {
          j = scanPastTrivia(source, j + 7);
          if (j < 0) return { error: 'unterminated comment in the MODULES declaration' };
          if (source[j] === ':') {
            j = skipUntilAssign(source, j + 1);
            if (j < 0) return { error: 'MODULES type annotation is unreadable' };
          }
          if (source[j] !== '=') return { error: 'MODULES is not assigned an object' };
          j = scanPastTrivia(source, j + 1);
          if (j < 0) return { error: 'unterminated comment before the MODULES object' };
          if (source[j] !== '{') return { error: 'MODULES is not an object' };
          const close = matchBracket(source, j, '{', '}');
          if (close < 0) return { error: 'MODULES object is unterminated' };
          return { bodyStart: j + 1, bodyEnd: close };
        }
      }
    }
    i++;
  }
  return { error: 'cannot find export const MODULES' };
}

function readKey(source, i, limit) {
  const c = source[i];
  if (c === "'" || c === '"') {
    const end = scanString(source, i);
    if (end === null || end > limit) return null;
    return { end };
  }
  if (!/[A-Za-z_$]/.test(c)) return null;
  let j = i + 1;
  while (j < limit && /[A-Za-z0-9_$]/.test(source[j])) j++;
  return { end: j };
}

function readIdent(source, i, limit) {
  if (!/[A-Za-z_$]/.test(source[i] || '')) return null;
  let j = i + 1;
  while (j < limit && /[A-Za-z0-9_$]/.test(source[j])) j++;
  return { name: source.slice(i, j), end: j };
}

function readValue(source, i, limit) {
  const c = source[i];
  if (c === "'" || c === '"' || c === '`') {
    const end = scanString(source, i);
    if (end === null || end > limit) return null;
    return { text: source.slice(i, end), end };
  }
  if (c === '{') {
    const close = matchBracket(source, i, '{', '}');
    if (close < 0 || close >= limit) return null;
    return { text: source.slice(i, close + 1), end: close + 1 };
  }
  if (c === '[') {
    const close = matchBracket(source, i, '[', ']');
    if (close < 0 || close >= limit) return null;
    return { text: source.slice(i, close + 1), end: close + 1 };
  }
  let j = i;
  let paren = 0;
  while (j < limit) {
    const cur = source[j];
    const next = source[j + 1];
    if (cur === '/' && (next === '/' || next === '*') && paren === 0) break;
    if (cur === "'" || cur === '"' || cur === '`') {
      const end = scanString(source, j);
      if (end === null || end > limit) return null;
      j = end;
      continue;
    }
    if (cur === '(') paren++;
    else if (cur === ')') {
      if (paren === 0) break;
      paren--;
    } else if (paren === 0 && (cur === ',' || cur === '}' || cur === ']')) break;
    else if (cur === '{' || cur === '[') {
      const close = matchBracket(source, j, cur, cur === '{' ? '}' : ']');
      if (close < 0 || close >= limit) return null;
      j = close + 1;
      continue;
    }
    j++;
  }
  const text = source.slice(i, j).trim();
  if (!text) return null;
  return { text, end: j };
}

function parseEntryFields(entry) {
  const fields = new Map();
  let i = 1;
  const end = entry.length - 1;
  while (i < end) {
    i = scanPastTrivia(entry, i);
    if (i < 0) return { error: 'unterminated comment in a module entry' };
    if (i >= end) break;
    const key = readIdent(entry, i, end);
    if (!key) return { error: 'unreadable field in a module entry' };
    i = scanPastTrivia(entry, key.end);
    if (i < 0) return { error: 'unterminated comment in a module entry' };
    if (i >= end || entry[i] !== ':') return { error: `field ${key.name} is missing :` };
    i = scanPastTrivia(entry, i + 1);
    if (i < 0) return { error: 'unterminated comment in a module entry' };
    if (i >= end) return { error: `field ${key.name} has an unreadable value` };
    const value = readValue(entry, i, end);
    if (!value) return { error: `field ${key.name} has an unreadable value` };
    if (fields.has(key.name)) return { error: `duplicate field ${key.name}` };
    fields.set(key.name, value.text);
    i = scanPastTrivia(entry, value.end);
    if (i < 0) return { error: 'unterminated comment in a module entry' };
    if (i < end && entry[i] === ',') {
      i++;
      continue;
    }
    if (i < end) return { error: `field ${key.name} is not followed by a comma` };
  }
  return { fields };
}

function parseQuotedName(text) {
  const match = text.match(/^(['"])([A-Za-z0-9_-]+)\1$/);
  return match ? match[2] : null;
}

function parsePlanes(text) {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1);
  const planes = [];
  let i = 0;
  while (i < inner.length) {
    i = scanPastTrivia(inner, i);
    if (i < 0) return null;
    if (i >= inner.length) break;
    if (inner[i] !== "'" && inner[i] !== '"') return null;
    const end = scanString(inner, i);
    if (end === null) return null;
    const name = parseQuotedName(inner.slice(i, end));
    if (name === null) return null;
    planes.push(name);
    i = scanPastTrivia(inner, end);
    if (i < 0) return null;
    if (i < inner.length && inner[i] === ',') {
      i++;
      continue;
    }
    if (i < inner.length) return null;
  }
  return planes;
}

function parseCustodial(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function classifyEntry(entrySource) {
  const parsed = parseEntryFields(entrySource);
  if (parsed.error) return { error: parsed.error };
  for (const name of ['service', 'planes', 'custodial']) {
    if (!parsed.fields.has(name)) return { error: `module entry is missing ${name}` };
  }
  const service = parseQuotedName(parsed.fields.get('service').trim());
  const planes = parsePlanes(parsed.fields.get('planes').trim());
  const custodial = parseCustodial(parsed.fields.get('custodial').trim());
  if (service === null || planes === null || custodial === null) {
    return { error: 'module entry service, planes, or custodial is not a literal' };
  }
  return { service, planes, custodial };
}

function parseRegistryEntries(source, bodyStart, bodyEnd) {
  const entries = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    i = scanPastTrivia(source, i);
    if (i < 0) return { error: 'unterminated comment in MODULES' };
    if (i >= bodyEnd) break;
    const key = readKey(source, i, bodyEnd);
    if (!key) return { error: 'unreadable module key in MODULES' };
    i = scanPastTrivia(source, key.end);
    if (i < 0) return { error: 'unterminated comment in MODULES' };
    if (i >= bodyEnd || source[i] !== ':') return { error: 'module entry is missing :' };
    i = scanPastTrivia(source, i + 1);
    if (i < 0) return { error: 'unterminated comment in MODULES' };
    if (i >= bodyEnd || source[i] !== '{') return { error: 'module entry is not an object' };
    const close = matchBracket(source, i, '{', '}');
    if (close < 0 || close >= bodyEnd) return { error: 'module entry object is unterminated' };
    entries.push(source.slice(i, close + 1));
    i = scanPastTrivia(source, close + 1);
    if (i < 0) return { error: 'unterminated comment in MODULES' };
    if (i < bodyEnd && source[i] === ',') {
      i++;
      continue;
    }
    if (i < bodyEnd) return { error: 'module entries must be separated by commas' };
  }
  return { entries };
}

/**
 * Protocol-only, non-custodial services in `export const MODULES`.
 * Field order and quote style do not matter. A nested `}` does not end an
 * entry. An entry that has service, planes, or custodial but is not a literal
 * fails the whole parse — a partial list must not look clean.
 */
function classifyProtocolPlaneServices(source) {
  const located = findModulesBody(source);
  if (located.error) return { ok: false, reason: located.error };
  const registry = parseRegistryEntries(source, located.bodyStart, located.bodyEnd);
  if (registry.error) return { ok: false, reason: registry.error };
  if (registry.entries.length === 0) {
    return { ok: false, reason: 'parsed MODULES and found no module entry' };
  }
  const derived = [];
  for (const entry of registry.entries) {
    const item = classifyEntry(entry);
    if (item.error) {
      return {
        ok: false,
        reason: `registry parse is partial (${item.error}). A protocol service in another shape must not be omitted.`,
      };
    }
    if (item.planes.length === 1 && item.planes[0] === 'protocol' && item.custodial === false) derived.push(item.service);
  }
  if (derived.length === 0) {
    return { ok: false, reason: 'parsed the registry and found no Protocol Plane module' };
  }
  return { ok: true, services: [...new Set(derived)].sort() };
}

function deriveProtocolPlaneServices() {
  if (!existsSync(MODULES_TS)) {
    console.error(`\n✖ CUSTODY SCAN FAILED — cannot read the module registry at ${relative(ROOT, MODULES_TS)}\n`);
    console.error('  The Protocol Plane service list is derived from it. Without it this gate does not know what to walk.\n');
    process.exit(1);
  }

  const result = classifyProtocolPlaneServices(readFileSync(MODULES_TS, 'utf8'));
  if (!result.ok) {
    console.error(`\n✖ CUSTODY SCAN FAILED — parsed ${relative(ROOT, MODULES_TS)} and found no Protocol Plane module\n`);
    console.error(`  ${result.reason}\n`);
    console.error('  Either the registry changed shape or every protocol module became custodial. Both need a human.\n');
    console.error('  A partial parse is the same failure: one matched entry must not hide a protocol service.\n');
    console.error('  This is a fail-closed guard: scanning an empty or partial set and printing ✓ is the bug it exists to prevent.\n');
    process.exit(1);
  }
  return result.services;
}

function registryFixture(body) {
  return `export const PLANES = ['fiat', 'protocol'] as const;\nexport const MODULES: Readonly<Record<string, unknown>> = {\n${body}\n};\n`;
}

function sameServiceSet(got, expected) {
  if (!Array.isArray(got) || got.length !== expected.length) return false;
  const left = [...got].sort();
  const right = [...expected].sort();
  return left.every((name, index) => name === right[index]);
}

/**
 * Hermetic fixtures. No secret values. Proves a second protocol service in
 * another shape is not dropped just because one canonical entry matched.
 */
function selfTest() {
  const fails = [];
  let checks = 0;
  const assert = (cond, message) => {
    checks++;
    if (!cond) fails.push(message);
  };
  const described = (result) => (result.ok ? result.services.join(',') : `FAIL:${result.reason}`);

  const canonical = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  // custodial:false service: 'svc-comment' must not count",
        "  /** planes: ['protocol'], custodial: false */",
        "  dex: { id: 'dex', service: 'svc-dex', planes: ['protocol'], phase: '5', custodial: false },",
        "  edge: { id: 'edge', service: 'svc-edge', planes: ['fiat', 'protocol'], phase: '1', custodial: false },",
        "  pay: { id: 'pay', service: 'svc-pay', planes: ['fiat'], phase: '3', custodial: true },",
        "  bridge: { id: 'bridge', service: 'svc-bridge', planes: ['fiat', 'protocol'], phase: '4P', custodial: true },",
        "  chain: { id: 'chain', service: 'svc-chain', planes: ['protocol'], phase: '4P', custodial: false },",
      ].join('\n'),
    ),
  );
  assert(canonical.ok === true, `canonical registry parses (${described(canonical)})`);
  assert(sameServiceSet(canonical.services, ['svc-chain', 'svc-dex']), `canonical services (${described(canonical)})`);

  const doubled = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { id: 'dex', service: 'svc-dex', planes: ['protocol'], phase: '5', custodial: false },",
        '  hidden: { id: "hidden", service: "svc-hidden", planes: ["protocol"], phase: "9", custodial: false },',
      ].join('\n'),
    ),
  );
  assert(
    doubled.ok === true && sameServiceSet(doubled.services, ['svc-dex', 'svc-hidden']),
    `double-quoted protocol service is examined (${described(doubled)})`,
  );

  const reordered = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { id: 'dex', service: 'svc-dex', planes: ['protocol'], phase: '5', custodial: false },",
        "  hidden: {",
        "    custodial: false,",
        "    phase: '9',",
        "    planes: ['protocol'],",
        "    id: 'hidden',",
        "    service: 'svc-hidden',",
        '  },',
      ].join('\n'),
    ),
  );
  assert(
    reordered.ok === true && sameServiceSet(reordered.services, ['svc-dex', 'svc-hidden']),
    `reordered protocol service is examined (${described(reordered)})`,
  );

  const planesAfterCustodial = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { service: 'svc-dex', planes: ['protocol'], custodial: false },",
        "  hidden: { service: 'svc-hidden', custodial: false, planes: ['protocol'] },",
      ].join('\n'),
    ),
  );
  assert(
    planesAfterCustodial.ok === true && sameServiceSet(planesAfterCustodial.services, ['svc-dex', 'svc-hidden']),
    `planes after custodial is examined (${described(planesAfterCustodial)})`,
  );

  const nested = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { service: 'svc-dex', planes: ['protocol'], custodial: false },",
        "  hidden: { service: 'svc-hidden', meta: { note: 'x' }, planes: ['protocol'], custodial: false },",
      ].join('\n'),
    ),
  );
  assert(
    nested.ok === true && sameServiceSet(nested.services, ['svc-dex', 'svc-hidden']),
    `nested brace does not hide a protocol service (${described(nested)})`,
  );

  const decoy = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { service: 'svc-dex', planes: ['protocol'], custodial: false },",
        `  note: { service: 'svc-note', planes: ['protocol'], custodial: false, decoy: "{ service: 'svc-decoy', planes: ['protocol'], custodial: false }" },`,
      ].join('\n'),
    ),
  );
  assert(
    decoy.ok === true && sameServiceSet(decoy.services, ['svc-dex', 'svc-note']),
    `string decoy is not a second service (${described(decoy)})`,
  );

  const unreadable = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { service: 'svc-dex', planes: ['protocol'], custodial: false },",
        "  hidden: { service: nameOf('hidden'), planes: ['protocol'], custodial: false },",
      ].join('\n'),
    ),
  );
  assert(unreadable.ok === false, `unreadable service is not a clean partial parse (${described(unreadable)})`);

  const spread = classifyProtocolPlaneServices(
    registryFixture(
      [
        "  dex: { service: 'svc-dex', planes: ['protocol'], custodial: false },",
        "  hidden: { service: 'svc-hidden', planes: ['protocol', ...extra], custodial: false },",
      ].join('\n'),
    ),
  );
  assert(spread.ok === false, `spread planes is not a clean partial parse (${described(spread)})`);

  const onlyFiat = classifyProtocolPlaneServices(
    registryFixture("  pay: { service: 'svc-pay', planes: ['fiat'], custodial: true },"),
  );
  assert(onlyFiat.ok === false, `zero protocol modules still fails closed (${described(onlyFiat)})`);

  const missing = classifyProtocolPlaneServices(
    "export const OTHER = { dex: { service: 'svc-dex', planes: ['protocol'], custodial: false } };",
  );
  assert(missing.ok === false, `missing MODULES is not a clean scan (${described(missing)})`);

  if (!existsSync(MODULES_TS)) {
    assert(false, 'live modules.ts is missing');
  } else {
    const live = classifyProtocolPlaneServices(readFileSync(MODULES_TS, 'utf8'));
    assert(live.ok === true, `live modules.ts parses (${described(live)})`);
    for (const service of ['svc-dex', 'svc-chain', 'svc-indexer', 'svc-protocol']) {
      assert(live.ok === true && live.services.includes(service), `live registry examines ${service} (${described(live)})`);
    }
    for (const service of ['svc-bridge', 'svc-pay', 'svc-edge', 'svc-ledger']) {
      assert(live.ok === true && !live.services.includes(service), `live registry does not treat ${service} as protocol-only (${described(live)})`);
    }
  }

  if (fails.length > 0) {
    console.error(`custody-scan --self-test FAIL (${fails.length}/${checks}):`);
    for (const failure of fails) console.error(`  · ${failure}`);
    process.exit(1);
  }
  console.log(`custody-scan --self-test OK (${checks} checks)`);
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun && process.argv.includes('--self-test')) selfTest();

const PROTOCOL_PLANE_SERVICES = deriveProtocolPlaneServices();

/** Importing any of these means the service can move value in the ledger. */
const WRITE_SURFACE = [
  { pattern: /\bledger\s*\.\s*post\s*\(/, reason: 'calls ledger.post() — that is custody' },
  { pattern: /from\s+['"]@intafaced\/ledger-client\/recipes['"]/, reason: 'imports ledger write recipes' },
  {
    pattern:
      /import\s*\{[^}]*\b(recipes|deposit|withdrawHold|withdrawSettle|tradeFill|escrowLock|escrowRelease|stake|feeCharge|rewardPay|mintEmission|loanCollateralLock|loanCollateralRelease|loanDraw|loanRepay|loanLiquidate|loanBadDebt|loanReserveFund)\b[^}]*\}\s*from\s*['"]@intafaced\/ledger-client['"]/s,
    reason: 'imports a ledger write recipe',
  },
  {
    pattern: /import\s*\{[^}]*\bLedgerClient\b[^}]*\}\s*from\s*['"]@intafaced\/ledger-client['"]/s,
    reason: 'imports the writable LedgerClient — use ReadOnlyLedgerClient on this plane',
  },
];

/** Solidity patterns that would hand the platform withdrawal power. */
const CONTRACT_RISKS = [
  {
    pattern: /function\s+\w*(withdraw|sweep|drain|rescue|emergencyWithdraw)\w*\s*\([^)]*\)[^{]*\bonlyOwner\b/i,
    reason: 'owner-callable withdrawal',
  },
  { pattern: /function\s+\w*(withdraw|sweep|drain|rescue)\w*\s*\([^)]*\)[^{]*\bonlyAdmin\b/i, reason: 'admin-callable withdrawal' },
  { pattern: /\btransferFrom\s*\([^)]*\bmsg\.sender\s*!=/i, reason: 'transferFrom on behalf of a non-caller' },
  { pattern: /\bselfdestruct\s*\(/i, reason: 'selfdestruct can strand or redirect user funds' },
];

/**
 * Maven module directory names that can move value if they boot.
 * Keys are directory basenames only — never a vendor package path (brand-scan).
 * Source: vendor Java money-plane map (D26-P2-02 / D26-P2-08 done bar).
 */
const RUNTIME_RISK_MODULES = ['admin', 'ucenter-api', 'otc-api', 'exchange-api', 'market', 'wallet', 'exchange', 'core'];

/** DB-4 successor — the only dual-book Java scanner. Do not fork its rules here. */
const JAVA_SUCCESSOR = join(ROOT, 'tooling', 'ci', 'vendor-java-money-scan.mjs');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'coverage', 'drizzle', 'target', '.git']);

function* walk(dir, extensions) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full, extensions);
    else if (extensions.some((ext) => name.endsWith(ext))) yield full;
  }
}

/** Repo-relative path with forward slashes. */
const relPath = (file) => relative(ROOT, file).split(sep).join('/');

/** Find Maven module roots named `module` that carry src/main/java. */
function findRuntimeModuleRoots(module) {
  const found = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (name === module && existsSync(join(full, 'src', 'main', 'java'))) found.push(full);
      visit(full);
    }
  }
  visit(VENDOR);
  return found;
}

const violations = [];
let filesScanned = 0;
let javaFilesScanned = 0;
let jarsScanned = 0;
let successorJavaScanned = 0;

// ── Check 1: no ledger writes on the Protocol Plane ─────────────────────────
for (const service of PROTOCOL_PLANE_SERVICES) {
  const dir = join(SERVICES, service);
  if (!existsSync(dir)) continue;

  for (const file of walk(dir, ['.ts', '.tsx'])) {
    filesScanned++;
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    for (const { pattern, reason } of WRITE_SURFACE) {
      if (pattern.test(content)) {
        violations.push({
          check: 'ledger-write-on-protocol-plane',
          file: rel,
          reason,
          detail: `${service} is a Protocol Plane service — it must never hold or move user value (§16.9, §22)`,
        });
      }
    }
  }
}

// ── Check 2: no platform withdrawal power in the contract suite ─────────────
//
// Walks EVERY Protocol Plane service, not just svc-protocol. It used to be
// `[svc-protocol, contracts/]` and there is no root contracts/, so in practice
// it read one service's .sol files and nothing else — which left
// services/svc-indexer/contracts/dev/DevVenue.sol scanned by neither check:
// check 1 reaches svc-indexer but reads only .ts/.tsx, and check 2 never looked
// outside svc-protocol. A contract is a contract wherever it is checked in.
const contractDirs = [...PROTOCOL_PLANE_SERVICES.map((s) => join(SERVICES, s)), join(ROOT, 'contracts')];
for (const dir of contractDirs) {
  for (const file of walk(dir, ['.sol'])) {
    filesScanned++;
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    for (const { pattern, reason } of CONTRACT_RISKS) {
      if (pattern.test(content)) {
        violations.push({
          check: 'platform-withdrawal-power',
          file: rel,
          reason,
          detail: 'No contract may grant platform keys withdrawal power over user funds (§16.10)',
        });
      }
    }
  }
}

// ── Check 3: vendor Java runtime risk surface (D26-P2-08) ───────────────────
//
// Scan object = money-plane src/main/java (openable) + committed jars (openable)
// + vendor-java-money-scan successor actually run. Dual-book rules stay in the
// successor — composing it is the point; copying its regexes is a third scanner.
if (!existsSync(VENDOR) || !statSync(VENDOR).isDirectory()) {
  console.error('\n✖ CUSTODY SCAN FAILED — vendor/ tree missing; cannot open the Java runtime risk surface (D26-P2-08)\n');
  process.exit(1);
}

const resolvedModules = [];
for (const module of RUNTIME_RISK_MODULES) {
  const roots = findRuntimeModuleRoots(module);
  if (roots.length === 0) {
    violations.push({
      check: 'java-runtime-risk-surface',
      file: `vendor/**/${module}/src/main/java`,
      reason: `runtime risk module "${module}" not found under vendor/`,
      detail: 'D26-P2-08 scan object is the money-plane runtime surface — a missing module is a hole, not a pass',
    });
    continue;
  }
  if (roots.length > 1) {
    violations.push({
      check: 'java-runtime-risk-surface',
      file: roots.map(relPath).join(', '),
      reason: `runtime risk module "${module}" resolved to ${roots.length} roots — key must be unique`,
      detail: 'Ambiguous module identity would let a second tree carry live writes unseen',
    });
    continue;
  }
  resolvedModules.push({ module, root: roots[0] });
}

for (const { module, root } of resolvedModules) {
  const mainJava = join(root, 'src', 'main', 'java');
  let moduleFiles = 0;
  for (const _file of walk(mainJava, ['.java'])) {
    moduleFiles++;
    javaFilesScanned++;
    filesScanned++;
  }
  if (moduleFiles === 0) {
    violations.push({
      check: 'java-runtime-risk-surface',
      file: relPath(mainJava),
      reason: `runtime risk module "${module}" has zero .java under src/main/java`,
      detail: 'Fail closed — an empty walk is not coverage of the runtime risk surface',
    });
  }
}

if (javaFilesScanned === 0) {
  console.error('\n✖ CUSTODY SCAN FAILED — opened vendor/ but scanned 0 Java files on the runtime risk surface (D26-P2-08)\n');
  console.error('  Green-over-empty is the failure mode this check exists to prevent.\n');
  process.exit(1);
}

for (const _jar of walk(VENDOR, ['.jar'])) {
  jarsScanned++;
  filesScanned++;
}

if (jarsScanned === 0) {
  violations.push({
    check: 'java-runtime-jar',
    file: 'vendor/**/*.jar',
    reason: 'no committed classpath jars found under vendor/',
    detail: 'Fail closed — the jar half of the runtime risk surface must be openable',
  });
}

if (!existsSync(JAVA_SUCCESSOR)) {
  console.error('\n✖ CUSTODY SCAN FAILED — vendor-java-money-scan.mjs missing; Java money/custody surface unscanned (D26-P2-08)\n');
  console.error('  Compose the DB-4 successor; do not fork a third scanner into this file.\n');
  process.exit(1);
}

const successor = spawnSync(process.execPath, [JAVA_SUCCESSOR], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
if (successor.stdout) process.stdout.write(successor.stdout);
if (successor.stderr) process.stderr.write(successor.stderr);
if (successor.error) {
  console.error('\n✖ CUSTODY SCAN FAILED — could not run vendor-java-money-scan successor (D26-P2-08)\n');
  console.error(`  ${successor.error.message}\n`);
  process.exit(1);
}
if (successor.status !== 0) {
  console.error('\n✖ CUSTODY SCAN FAILED — Java money/custody successor is red (vendor-java-money-scan)\n');
  process.exit(1);
}
const successorText = `${successor.stdout ?? ''}\n${successor.stderr ?? ''}`;
const successorMatch = successorText.match(/(\d+)\s+Java file\(s\)/);
successorJavaScanned = successorMatch ? Number(successorMatch[1]) : 0;
if (!Number.isFinite(successorJavaScanned) || successorJavaScanned === 0) {
  console.error('\n✖ CUSTODY SCAN FAILED — successor printed clean without scanning Java files (D26-P2-08)\n');
  console.error('  The Java money/custody surface was unscanned. Green here would be TS-only theater.\n');
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`\n✖ CUSTODY SCAN FAILED — ${violations.length} boundary violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.check}] ${v.file}`);
    console.error(`    → ${v.reason}`);
    console.error(`      ${v.detail}\n`);
  }
  console.error('  Provably non-custodial or it does not merge (Doctrine §16.10).\n');
  process.exit(1);
}

const scanned = PROTOCOL_PLANE_SERVICES.filter((s) => existsSync(join(SERVICES, s)));
// Name the registered-but-unbuilt services out loud. The count alone reads as
// full coverage of the registry, and it is not: svc-chain is declared in
// modules.ts and has no directory, so "3 services" silently means "3 of 4".
const pending = PROTOCOL_PLANE_SERVICES.filter((s) => !existsSync(join(SERVICES, s)));
console.log(
  `✓ custody-scan clean — ${filesScanned} files across ${scanned.length} Protocol Plane service(s) derived from modules.ts` +
    `${scanned.length === 0 ? ' (none built yet — check re-arms automatically when the first one lands)' : ''}` +
    `${pending.length > 0 ? `; ${pending.join(', ')} registered but not built yet — arms automatically` : ''}` +
    `; Java runtime risk surface ${javaFilesScanned} src/main .java + ${jarsScanned} jar(s); successor vendor-java-money-scan walked ${successorJavaScanned} Java file(s) (D26-P2-08)`,
);
