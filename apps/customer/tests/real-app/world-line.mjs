/**
 * A journey file's `// World:` line: which parts of the one shared test world the file changes. The journeys read it to
 * put the world back between files (world-restore.mjs), and the CI scan (tooling/scripts/journey-world.mjs) reads it from
 * here to hold each file to what it does. The harness owns the line's meaning and the scan depends on it, never the
 * reverse, so a change to the scan reaches no journey (docs/runbooks/harness-rewrite-plan.md, piece 2). Failure it
 * prevents: world-restore.mjs imported the scan, so every journey step rested on it, and one small scan change
 * (#7272) kept 508 steps from counting until it was read.
 */

/** The shared parts a journey can change, and what each means. */
export const WORLD = {
  book: 'rests, places or runs orders, algos or bots on a shared order book',
  market: 'stops, starts, moves or delists the TEST market maker',
  restart: 'restarts, stops or starts a stack service, or rewinds the TEST chain',
  freeze: 'switches the platform-wide posting freeze',
  gates: 'sets a platform-wide gate, limit, fee, risk or fault at runtime',
  stack: "runs one of the stack's global tools (ageing, expiry, seeding, ticks, world events)",
};

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

/**
 * Whether a journey file needs a fresh stack: a `// Stack: fresh` line. Its steps read something every journey file
 * shares and none puts back (the launch catalogue, a global list or count), as a fresh stack leaves it, so the shard plan
 * runs it first in its shard, before any other file can have used the stack (tooling/scripts/journey-shards.mjs
 * `planShards`; Playwright runs a shard's files in name order). Failure it prevents: J-more-catalogue-11 #1 read the open
 * TEST launch J-more-catalogue-01 #6 had made earlier in its shard (#7994).
 */
export function stackFresh(src) {
  return /^\/\/ Stack: fresh$/m.test(src);
}

/**
 * Whether a journey file reads the TEST market moving on its own: a `// Market: live` line. Every other file runs on a
 * still market (local-test-market.mjs `still`): the maker quotes the same ladder at the same TEST PRICE and nothing crosses
 * it, so a price, mark, candle or total moves only when someone trades. A file that waits for the market's own trades
 * (new candles, a last price that ticks, a walk that drifts into a resting order) carries the line.
 */
export function marketLive(src) {
  return /^\/\/ Market: live$/m.test(src);
}

/** The `// World:` line a file with these parts needs, parts in WORLD's order. */
export function worldLine(parts) {
  const ordered = Object.keys(WORLD).filter((p) => parts.has(p));
  return `// World: ${ordered.length ? ordered.join(', ') : 'none'}`;
}
