#!/usr/bin/env node
/**
 * CALL GRAPH. Which service calls which, read from each service's own code, so the order of the service waves
 * comes from the code and not from a hand-kept list.
 *
 *   node tooling/shape/call-graph.mjs          rewrite tooling/shape/call-graph.json and print the longest chain
 *   node tooling/shape/call-graph.mjs --check  fail if tooling/shape/call-graph.json is stale (CI runs call-graph.test.mjs)
 *
 * A service calls another when its source (services/<svc>/src, tests, fixtures and its env schema left out) names
 * that service's address variable outside a comment: `LEDGER_URL` → svc-ledger, `IDENTITY_CLOSURE_BANK_URL` →
 * svc-bank, `FIX_STATUS_URL` → svc-fix. Every client and record call takes its address from one of these. A line that
 * names one without calling it (it only reports whether the address is set) ends with `shape-not-a-call: <reason>`.
 *
 * Output: `{ "services": { "svc-<name>": { "calls": [...], "calledBy": [...] } }, "cycles": [[...]], "longestChain": [...] }`,
 * every service directory a key. `cycles` are the groups of services that call each other round; `longestChain` is
 * the longest run of calls, a cycle counted as one link.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = 'tooling/shape/call-graph.json';
export const NOT_A_CALL = 'shape-not-a-call:';

const SOURCE = /\.(?:[cm]?[jt]s|tsx|java|rs)$/;
const SKIP_FILE = /(?:\.(?:test|spec|fixture)\.[^.]+$|\.d\.ts$|^env(?:\.[^.]+)?\.[cm]?[jt]s$)/;
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', 'test', 'tests', 'fixtures', '__fixtures__']);

/** Service folder names under `root/services`, sorted. */
export function servicesOf(root = ROOT) {
  const dir = join(root, 'services');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('svc-'))
    .map((e) => e.name)
    .sort();
}

/** `svc-mining-pool` → `MINING_POOL`. */
const envName = (svc) => svc.slice(4).toUpperCase().replaceAll('-', '_');

/**
 * The service an address variable points at, from `self`'s side, or null. `<S>_URL(S)`, `…_<S>_URL(S)` and
 * `<S>_…_URL(S)` name svc-<s>; a variable of `self`'s own (`TRADE_USER_VENUE_URL` in svc-trade) is its own setting.
 */
export function targetOf(variable, self, services) {
  const m = variable.match(/^([A-Z0-9_]+?)_URLS?$/);
  if (!m) return null;
  const stem = m[1];
  // Longest name first, so MINING_POOL wins over a shorter name it contains.
  const byLength = [...services].sort((a, b) => envName(b).length - envName(a).length);
  for (const svc of byLength) {
    const n = envName(svc);
    if (stem === n || stem.endsWith(`_${n}`)) return svc === self ? null : svc;
  }
  if (stem.startsWith(`${envName(self)}_`)) return null;
  for (const svc of byLength) if (stem.startsWith(`${envName(svc)}_`)) return svc === self ? null : svc;
  return null;
}

/** The text with comments blanked out (strings and template text kept), lines kept in place. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

function sourceFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) walk(join(d, entry.name));
      } else if (entry.isFile() && SOURCE.test(entry.name) && !SKIP_FILE.test(entry.name)) found.push(join(d, entry.name));
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

/** The services one file's code calls. */
export function callsInSource(src, self, services) {
  const calls = new Set();
  const raw = src.split('\n');
  stripComments(src)
    .split('\n')
    .forEach((line, n) => {
      if (raw[n].includes(NOT_A_CALL)) return;
      for (const [variable] of line.matchAll(/\b[A-Z][A-Z0-9_]*_URLS?\b/g)) {
        const to = targetOf(variable, self, services);
        if (to) calls.add(to);
      }
    });
  return calls;
}

/** Strongly connected groups of more than one service, each sorted, sorted by first name. */
function cyclesOf(services, graph) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const groups = [];
  const visit = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    on.add(v);
    for (const w of graph[v].calls) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        group.push(w);
      } while (w !== v);
      groups.push(group.sort());
    }
  };
  for (const s of services) if (!idx.has(s)) visit(s);
  return groups;
}

/**
 * The longest run of calls. A cycle counts as one link (its services move together), written as its members joined
 * by ` + `; ties go to the run that sorts first.
 */
function longestChainOf(graph, groups) {
  const groupOf = new Map();
  for (const g of groups) for (const s of g) groupOf.set(s, g.join(' + '));
  const nodes = [...new Set(groupOf.values())].sort();
  const edges = new Map(nodes.map((n) => [n, new Set()]));
  for (const [svc, { calls }] of Object.entries(graph))
    for (const to of calls) if (groupOf.get(svc) !== groupOf.get(to)) edges.get(groupOf.get(svc)).add(groupOf.get(to));
  const memo = new Map();
  const from = (n) => {
    if (memo.has(n)) return memo.get(n);
    let best = [n];
    for (const to of [...edges.get(n)].sort()) {
      const tail = from(to);
      if (tail.length + 1 > best.length) best = [n, ...tail];
    }
    memo.set(n, best);
    return best;
  };
  let best = [];
  for (const n of nodes) if (from(n).length > best.length) best = from(n);
  return best;
}

/** The graph from each service's source texts: `{ [svc]: string[] }`, every service a key. */
export function graphFrom(sources) {
  const services = Object.keys(sources).sort();
  const graph = {};
  for (const svc of services) {
    const calls = new Set();
    for (const src of sources[svc]) for (const to of callsInSource(src, svc, services)) calls.add(to);
    graph[svc] = { calls: [...calls].sort(), calledBy: [] };
  }
  for (const svc of services) for (const to of graph[svc].calls) graph[to].calledBy.push(svc);
  const groups = cyclesOf(services, graph);
  return {
    services: graph,
    cycles: groups.filter((g) => g.length > 1).sort((a, b) => a[0].localeCompare(b[0])),
    longestChain: longestChainOf(graph, groups),
  };
}

/** Each service's source texts in the tree at `root`. */
export function sourcesOf(root = ROOT) {
  return Object.fromEntries(
    servicesOf(root).map((svc) => [svc, sourceFiles(join(root, 'services', svc, 'src')).map((f) => readFileSync(f, 'utf8'))]),
  );
}

const buildGraph = (root = ROOT) => graphFrom(sourcesOf(root));

/** The file's text, in the repo's own format so the format check and this check agree. */
export const render = async (graph) =>
  format(JSON.stringify(graph), { ...(await resolveConfig(join(ROOT, OUT))), filepath: join(ROOT, OUT) });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const graph = buildGraph();
  const text = await render(graph);
  const path = join(ROOT, OUT);
  if (process.argv.includes('--check')) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== text) {
      console.error(`${OUT} is stale. Run \`node tooling/shape/call-graph.mjs\` and commit the result.`);
      process.exit(1);
    }
  } else writeFileSync(path, text);
  const chain = graph.longestChain;
  console.log(`${Object.keys(graph.services).length} services; longest chain ${chain.length}: ${chain.join(' → ')}`);
  for (const c of graph.cycles) console.log(`cycle (${c.length}): ${c.join(', ')}`);
}
