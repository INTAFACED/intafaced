// The one test world: what each journey file changes in the world every journey shares, declared and checked.
//
// Every journey runs against one stack: one TEST market maker and its books, one platform-wide posting freeze, services
// that a journey may restart with a setting switched, platform gates set at runtime, and the stack's own global tools.
// A journey that changes one of these and leaves it changed breaks whichever journey runs next, and which one that is
// changes from run to run (failure it prevents: J-copy-bots-otc-30 #1 left a TEST bid resting on BTC/USDT, J-ops-console-08
// #7 restarted the market maker, and J-portfolio-04 #1 then timed out on main, run 1247; #7176 and #7175 were reverted
// for it and every lane stopped for 77 minutes, though their code passed alone, run 1262).
//
// So each journey file says, in a line near its top, which shared parts it changes:
//
//   // World: none
//   // World: book, market, restart
//
// and this scan finds what the file (and every journey helper it calls) actually does, and fails a file whose line
// leaves out anything it does, or that has no line. Declaring more than it does is allowed: it only costs speed.
// The journeys put back what a file changed before the next file starts (apps/customer/tests/real-app/world-restore.mjs).
//
// Usage: node tooling/scripts/journey-world.mjs [--dir <journey folder>] [--suggest]
//   Exits 1 naming every file whose declaration is missing or short. --suggest prints the line each file needs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOURNEY_DIR = 'apps/customer/tests/real-app';

/** The shared parts a journey can change, and what each means. */
export const WORLD = {
  book: 'rests, places or runs orders, algos or bots on a shared order book',
  market: 'stops, starts, moves or delists the TEST market maker',
  restart: 'restarts, stops or starts a stack service, or rewinds the TEST chain',
  freeze: 'switches the platform-wide posting freeze',
  gates: 'sets a platform-wide gate, limit, fee, risk or fault at runtime',
  stack: "runs one of the stack's global tools (ageing, expiry, seeding, ticks, world events)",
};

// Subcommands that act on one named account only, so they change nothing another journey can see.
const PER_ACCOUNT = {
  'local-test-gates.mjs': new Set(['verify', 'status', 'kyc-reject']),
  'local-test-stack.mjs': new Set(['fund', 'chain-deposit', 'bank-transfer', 'card-funds']),
  'local-test-market.mjs': new Set(['status']),
  'local-test-chain.mjs': new Set(['status', 'fund']),
};
const RESTARTS = new Set(['restart', 'stop', 'start', 'second-worker', 'chain-reorg']);
// Every market-maker command but `status` changes what the maker quotes or whether it runs.
const MARKET_READS = new Set(['status']);

// The order, algo, bot and position routes on a shared book. A write to one, however it is sent, is a change to the book.
const BOOK_ROUTE = String.raw`\/api\/(?:v1\/(?:orders|futures\/orders|algo|bots\/|positions)|trade\/trpc\/algo\.create)`;
const BOOK = [
  // `me.post('/api/v1/orders', …)`, `client.post(…)`.
  new RegExp(String.raw`\.post\(\s*['\x60]` + BOOK_ROUTE),
  // `call('POST', '/api/v1/bots/grid', …)`, `http('POST', …)`, `fetch(…, { method: 'POST' … })` near the route.
  new RegExp(String.raw`['"]POST['"]\s*,\s*['\x60]` + BOOK_ROUTE),
  new RegExp(String.raw`method:\s*['"]POST['"][^;]{0,200}?path:\s*['\x60]` + BOOK_ROUTE, 's'),
  new RegExp(String.raw`path:\s*['\x60]` + BOOK_ROUTE + String.raw`[^;]{0,200}?method:\s*['"]POST['"]`, 's'),
  // The same through the screens: a click on the button that places, opens, closes or swaps…
  /getByRole\(\s*'button',\s*\{\s*name:\s*['`/]\^?(?:Buy|Sell|Open long|Open short|Close position|Confirm (?:open|close|buy|sell|swap)|Place order|Place as|Swap)\b[^\n]*?\)\s*\)?\s*\.(?:dbl)?click\(/,
  // …and a helper that names such a button by a computed name (desk.mjs `confirm`: 'Confirm buy' : 'Confirm sell').
  /['`](?:Confirm (?:buy|sell|open long|open short)|Place order)['`]\s*[:)]/,
  /`(?:Buy|Sell|Confirm|Open) \$\{/,
];
const FREEZE = [/ledger-freeze/, /tool\(\s*'local-test-gates\.mjs',\s*'posting-freeze'/];
// A stack script run some other way than `tool(…)` (execFileSync, spawnSync, a path joined by hand): its own tools.
const STACK_SCRIPT = /['`][^'`\n]*\blocal-test[a-z-]*\.mjs['`]/g;

/** The world parts one piece of source touches directly (not through helpers). */
export function directWorld(src) {
  const found = new Set();
  if (BOOK.some((re) => re.test(src))) found.add('book');
  if (FREEZE.some((re) => re.test(src))) found.add('freeze');
  if (/\brestartWith\(/.test(src)) found.add('restart');
  const viaTool = new Set();
  for (const m of src.matchAll(/\btool\(\s*'([a-z-]+\.mjs)'\s*(?:,\s*('([a-z-]+)'|[^,)]+))?/g)) {
    viaTool.add(m.index);
    const [, script, , literal] = m;
    // A subcommand the source computes counts as every part it could be.
    const sub = literal ?? null;
    if (sub && PER_ACCOUNT[script]?.has(sub)) continue;
    if (script === 'local-test-market.mjs') {
      if (sub === null || !MARKET_READS.has(sub)) found.add('market');
    } else if (script === 'local-test-chain.mjs') {
      if (sub === null || sub === 'gate') found.add('gates');
      if (sub !== 'gate') found.add('restart');
    } else if (script === 'local-test-gates.mjs') {
      if (sub === null || sub === 'posting-freeze') found.add('freeze');
      if (sub !== 'posting-freeze') found.add('gates');
    } else if (script === 'local-test-stack.mjs') {
      if (sub === null || RESTARTS.has(sub)) found.add('restart');
      if (sub === null || !RESTARTS.has(sub)) found.add('stack');
    } else found.add('stack');
  }
  // A stack script named outside `tool(…)` and outside an import: run by hand, so it counts as the stack's tools.
  for (const m of src.matchAll(STACK_SCRIPT)) {
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    if (/\btool\(\s*$/.test(before) || /\bfrom\s*$|\bimport\(\s*$|^\s*import\b[^\n]*$/.test(before.split('\n').at(-1) + '')) continue;
    if (/local-test-(device|state)\.mjs/.test(m[0])) continue; // read-only helpers: the TEST device key and the state path
    found.add('stack');
  }
  return found;
}

/**
 * Top-level functions of a helper module and their bodies: `function f(`, `async function f(`, `const f = (...) =>`,
 * each exported or not, up to the next top-level declaration.
 */
export function topLevelFunctions(src) {
  const lines = src.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    const m =
      /^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line) ??
      /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line);
    if (m) starts.push({ name: m[1], at: i });
  });
  // A top-level line that starts something else (a const, a class, an export block) ends the function before it.
  const ends = lines.map((line) => /^(?:export\s+)?(?:const|let|var|class|function|async|import)\b|^export\s*\{/.test(line));
  return starts.map(({ name, at }, k) => {
    let end = k + 1 < starts.length ? starts[k + 1].at : lines.length;
    for (let i = at + 1; i < end; i++)
      if (ends[i]) {
        end = i;
        break;
      }
    return { name, body: lines.slice(at, end).join('\n') };
  });
}

/**
 * What every journey helper function touches, through the helpers it calls in turn: the journey folder's helper
 * modules (every `.mjs` that is not a journey file or the Playwright config), worked to a fixed point.
 */
export function helperWorld(dir) {
  // Keyed by module and name; a call by name counts every module's function of that name (two helpers may share one).
  const fns = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.pw.mjs') && !f.endsWith('.config.mjs')))
    for (const { name, body } of topLevelFunctions(fs.readFileSync(path.join(dir, f), 'utf8')))
      fns.push({ name, body, world: directWorld(body), call: new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(`) });
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of fns)
      for (const other of fns)
        if (other !== fn && other.world.size && other.call.test(fn.body))
          for (const part of other.world)
            if (!fn.world.has(part)) {
              fn.world.add(part);
              changed = true;
            }
  }
  const byName = new Map();
  for (const fn of fns) byName.set(fn.name, new Set([...(byName.get(fn.name) ?? []), ...fn.world]));
  return byName;
}

/** What a journey file touches: its own source, and every helper function it calls. */
export function fileWorld(src, helpers) {
  const found = directWorld(src);
  for (const [name, world] of helpers)
    if (world.size && new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(`).test(src)) for (const part of world) found.add(part);
  return found;
}

/** The parts a file's `// World:` line declares, or null when it has none. An unknown part is an error. */
export function declaredWorld(src) {
  const m = /^\/\/ World: (.+)$/m.exec(src);
  if (!m) return null;
  const words = m[1]
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 1 && words[0] === 'none') return new Set();
  const unknown = words.filter((w) => !(w in WORLD));
  if (unknown.length || words.includes('none')) throw new Error(`unknown world part(s): ${unknown.join(', ') || 'none with others'}`);
  return new Set(words);
}

/** The `// World:` line a file with these parts needs, parts in WORLD's order. */
export function worldLine(parts) {
  const ordered = Object.keys(WORLD).filter((p) => parts.has(p));
  return `// World: ${ordered.length ? ordered.join(', ') : 'none'}`;
}

/** Every journey file's verdict: what it declares, what it does, and what its line leaves out. */
export function scan(dir = JOURNEY_DIR) {
  const helpers = helperWorld(dir);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.pw.mjs'))
    .sort()
    .map((file) => {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const does = fileWorld(src, helpers);
      let declared;
      let error = null;
      try {
        declared = declaredWorld(src);
      } catch (err) {
        error = err.message;
      }
      const missing = declared ? [...does].filter((p) => !declared.has(p)) : [...does];
      return { file, does, declared: declared ?? null, missing, error };
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : JOURNEY_DIR;
  const rows = scan(dir);
  if (argv.includes('--suggest')) {
    for (const r of rows) console.log(`${r.file}\t${worldLine(r.does)}`);
    process.exit(0);
  }
  const bad = rows.filter((r) => r.error || r.declared === null || r.missing.length);
  for (const r of bad)
    console.error(
      r.error
        ? `${r.file}: ${r.error}`
        : r.declared === null
          ? `${r.file}: no "// World:" line; it needs: ${worldLine(r.does)}`
          : `${r.file}: changes ${r.missing.join(', ')} but does not declare it; it needs: ${worldLine(new Set([...r.declared, ...r.does]))}`,
    );
  const counts = Object.fromEntries(Object.keys(WORLD).map((p) => [p, rows.filter((r) => r.declared?.has(p)).length]));
  console.log(
    `journey-world: ${rows.length} journey files, ${rows.filter((r) => r.declared?.size === 0).length} change nothing shared; declared ${JSON.stringify(counts)}`,
  );
  if (bad.length) {
    console.error(`journey-world: ${bad.length} file(s) change the shared world without declaring it (see ${JOURNEY_DIR}, "// World:")`);
    process.exit(1);
  }
}
