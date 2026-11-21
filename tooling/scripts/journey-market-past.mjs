#!/usr/bin/env node
/**
 * Whether a targeted journeys shard needs the TEST chart history (`local-test-market.mjs history --markets journeys`),
 * the past TEST trades charts, candles, the tape and 24-hour figures read. Writing it is most of a shard's market step
 * (208 s of 297 on run 43668181917, shard 1, 15 Nov), and a by-hand run whose journeys read no market's past pays it on
 * every try.
 *
 * A journey file reads the past when its own source, or any helper it imports from the journeys folder, says so
 * (READS_PAST), or when it imports `local-test-market.mjs` itself. Anything this can't read (a missing file, an
 * import it can't resolve, an empty list) counts as reading the past, so a doubt always writes the history. A journey
 * that reads the past and is called history-free fails on the empty chart it then sees; it never passes on one.
 * Every run with a shard plan asks, full runs too (main's, a pull request's): a shard is one stack, so only its own
 * files decide (.github/workflows/real-app-journeys.yml, the market step). A run without a plan (Playwright's own
 * split) always writes it. (Failure it prevents: project-state#3329, 19 Nov 2026: full runs of 90 shards held all 500
 * of GitHub's hosted runners, run 44514711810 had 78 shards waiting, and every shard paid the history's minutes, though
 * 43 of 90 shards of a full plan read no market's past.)
 *
 * Usage: node tooling/scripts/journey-market-past.mjs <journey file>...   (names in apps/customer/tests/real-app)
 *        node tooling/scripts/journey-market-past.mjs --shard <n>        (the shard plan's JSON in the SHARDS env)
 * Prints `journeys` (write the history) or `none` on stdout, and each file that reads the past, with why, on stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const JOURNEYS_DIR = join(ROOT, 'apps/customer/tests/real-app');

/**
 * Words a source uses when it reads what past trades make: charts, candles and klines, the public tape and trades route,
 * backtests and sparklines. Measured, not guessed: probe run 43672068757 (15 Nov) ran every journey with no history,
 * and the 37 steps that went red, in J-algo-dev-05 and -06 and J-charts-desk-01, 03 to 09 and 17, are all in files these
 * words name; every other journey matched main. A word too many costs a shard the history's minutes; a word too few
 * lets a journey run without the past it reads, and it then fails on the empty chart.
 */
export const READS_PAST = /candle|ohlcv|kline|chart|tape|\/trades\b|backtest|sparkline/i;

/** A source without its block comments and its whole-line or trailing `//` comments (a URL's `//` stays). */
export function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The relative imports a source names, static or dynamic. */
function relativeImports(src) {
  return [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * Why the journey file `file` (a path) reads a market's past, as short reasons; empty when it provably reads none.
 * Follows relative imports inside the journeys folder; an import of the TEST market script is a reason by itself.
 */
export function pastReads(file, { dir = JOURNEYS_DIR, read = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const reasons = [];
  const seen = new Set();
  const walk = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    if (!exists(p)) {
      reasons.push(`${p}: can't be read`);
      return;
    }
    const src = read(p);
    // A helper's comments read nothing; the journey file's own count, so a step that says it reads a chart counts.
    const hit = READS_PAST.exec(p === start ? src : withoutComments(src));
    if (hit) reasons.push(`${p.slice(dir.length + 1)}: "${hit[0]}"`);
    for (const spec of relativeImports(src)) {
      const target = resolve(dirname(p), spec);
      if (target.endsWith(`${sep}local-test-market.mjs`)) reasons.push(`${p.slice(dir.length + 1)}: imports the TEST market script`);
      else if (target.startsWith(dir + sep) && /\.m?js$/.test(target)) walk(target);
    }
  };
  const start = resolve(dir, file);
  walk(start);
  return reasons;
}

/** `none` only when every named file provably reads no market's past; `journeys` otherwise, and for no files at all. */
export function historyFor(files, opts = {}) {
  const named = files.filter(Boolean);
  if (!named.length) return { history: 'journeys', reasons: ['no journey files named'] };
  const reasons = named.flatMap((f) => (/^[A-Za-z0-9._-]+\.pw\.mjs$/.test(f) ? pastReads(f, opts) : [`${f}: not a journey file name`]));
  return { history: reasons.length ? 'journeys' : 'none', reasons };
}

/**
 * The history for shard `n` (from 1) of a shard plan (journey-shards.mjs: a JSON array, one string of space-separated
 * journey files per shard). A plan that can't be read, a shard it lacks or an empty shard writes the history.
 */
export function historyForShard(plan, n, opts = {}) {
  let shards;
  try {
    shards = JSON.parse(plan);
  } catch {
    return { history: 'journeys', reasons: ['the shard plan is not JSON'] };
  }
  const files = Array.isArray(shards) && Number.isInteger(n) && n >= 1 ? shards[n - 1] : undefined;
  if (typeof files !== 'string') return { history: 'journeys', reasons: [`the shard plan has no shard ${n}`] };
  return historyFor(files.split(' '), opts);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let out = { history: 'journeys', reasons: [] };
  try {
    const args = process.argv.slice(2);
    out =
      args[0] === '--shard'
        ? historyForShard(process.env.SHARDS ?? '', Number(args[1]))
        : historyFor(args.flatMap((a) => a.split(/[\s,]+/)));
  } catch (err) {
    out.reasons.push(`unreadable: ${err.message}`);
  }
  for (const r of out.reasons) console.error(`reads the past: ${r}`);
  console.log(out.history);
}
