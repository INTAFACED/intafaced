#!/usr/bin/env node
/**
 * Starts one headless builder (.github/workflows/builder.yml) per journey: `gh workflow run builder.yml --ref main
 * -f journey=<id> -f area=<area> -f account=<account>`, once each, in the order given.
 *
 * Usage (from the repo root):
 *   node tooling/factory/dispatch.mjs J-identity-13 J-wallet-05
 *   node tooling/factory/dispatch.mjs --area identity J-identity-13 J-identity-14
 *   node tooling/factory/dispatch.mjs J-identity-13=identity J-wallet-05=wallet
 *   node tooling/factory/dispatch.mjs --account acct4 J-identity-13
 *   node tooling/factory/dispatch.mjs --dry-run ...      (prints the commands, starts nothing)
 *
 * A journey's area is, in order: its own `=area`, then --area, then its module in docs/roadmap/journeys.json. Every
 * journey's CLI account is --account, else the accounts in turn (acct1, acct3, acct4, then acct1 again), so a
 * batch spreads over them and never draws on the CI review's account. Every
 * journey is checked before any run starts: an unknown or parked journey, or a malformed id or area, starts none.
 * On a 403 or 429 from GitHub it stops and starts no more (AGENTS.md); the builder itself reads the factory switch.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkInputs } from '../ci/factory-builder.mjs';

export const REPO = 'INTAFACED/intafaced';
export const WORKFLOW = 'builder.yml';
/** builder.yml's `account` choices, each with its own CLI token in the environment factory (CLAUDE_TOKEN_<ACCOUNT>). */
export const ACCOUNTS = ['acct1', 'acct3', 'acct4'];

/** The parsed command line: { journeys: [{ journey, area? }], area?, dryRun, repo } or { error }. */
export function parseArgs(argv) {
  const out = { journeys: [], area: null, account: null, dryRun: false, repo: REPO };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--area' || a === '--repo' || a === '--account') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { error: `${a} needs a value` };
      out[a.slice(2)] = v;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else
      for (const part of a.split(',').filter(Boolean)) {
        const [journey, area] = part.split('=');
        out.journeys.push(area === undefined ? { journey } : { journey, area });
      }
  }
  if (!out.journeys.length) return { error: 'name at least one journey, e.g. J-identity-13' };
  if (out.account !== null && !ACCOUNTS.includes(out.account)) return { error: `--account is one of ${ACCOUNTS.join(', ')}` };
  return out;
}

/** Each journey's gh arguments, or the first problem found (so nothing starts unless all are good). */
export function plan({ journeys, area, account }, catalog) {
  const seen = new Set();
  const runs = [];
  for (const j of journeys) {
    if (seen.has(j.journey)) return { error: `${j.journey} is named twice` };
    seen.add(j.journey);
    const module = catalog.find((x) => x?.id === j.journey)?.module;
    const chosen = j.area ?? area ?? module;
    const r = checkInputs(j.journey, chosen, catalog);
    if (r.error) return { error: r.error };
    runs.push({ journey: j.journey, area: chosen, account: account ?? ACCOUNTS[runs.length % ACCOUNTS.length] });
  }
  return { runs };
}

export function ghArgs(run, repo = REPO) {
  return [
    'workflow',
    'run',
    WORKFLOW,
    '-R',
    repo,
    '--ref',
    'main',
    '-f',
    `journey=${run.journey}`,
    '-f',
    `area=${run.area}`,
    '-f',
    `account=${run.account}`,
  ];
}

/** A refusal that ends the batch: a 403 or 429, or GitHub's rate-limit words. */
export function isRefusal(text) {
  return /\bHTTP (403|429)\b|rate limit|secondary rate/i.test(String(text ?? ''));
}

/** Runs the plan through `exec` (gh); stops at the first refusal. Returns { started, failed, stopped }. */
export function dispatch(runs, { exec, repo = REPO, log = console.log }) {
  const result = { started: [], failed: [], stopped: null };
  for (const run of runs) {
    try {
      exec('gh', ghArgs(run, repo));
      result.started.push(run.journey);
      log(`started ${run.journey} (area ${run.area}, account ${run.account})`);
    } catch (e) {
      const text = `${e?.stderr ?? ''} ${e?.message ?? ''}`;
      if (isRefusal(text)) {
        result.stopped = `${run.journey}: GitHub refused (${text.trim().split('\n')[0].slice(0, 200)}); no more started`;
        log(result.stopped);
        return result;
      }
      result.failed.push(run.journey);
      log(`${run.journey} did not start: ${text.trim().split('\n')[0].slice(0, 200)}`);
    }
  }
  return result;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) throw new Error(args.error);
  const catalog = JSON.parse(readFileSync('docs/roadmap/journeys.json', 'utf8'));
  const p = plan(args, catalog);
  if (p.error) throw new Error(`${p.error}; nothing started`);
  if (args.dryRun) {
    for (const run of p.runs) console.log(['gh', ...ghArgs(run, args.repo)].join(' '));
    return 0;
  }
  const exec = (cmd, a) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const r = dispatch(p.runs, { exec, repo: args.repo });
  console.log(`${r.started.length} of ${p.runs.length} builders started${r.failed.length ? `; failed: ${r.failed.join(' ')}` : ''}`);
  return r.stopped || r.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`dispatch: ${e.message}`);
    process.exit(1);
  }
}
