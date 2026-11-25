#!/usr/bin/env node
/**
 * CI's cheap checks on what a push changes, run by .githooks/pre-push before the push, the way t3code's agents run
 * `check:changed` ("It runs CI's fast checks for changed files: format, lint, knip, ...", pingdotgg/t3code@e414cfd
 * AGENTS.md:103). Nino's decision of 23 Nov 2026 (project-state#3859, weed project-state#3754): 704 of 1,046 first pushes
 * passed CI over 16-23 Nov; of the 210 that failed, 61 left a generated or recorded file stale and 20 failed dead-code.
 *
 * Each check runs only when the push changes what it reads, runs CI's own command or test, and a refusal names the
 * command that fixes it:
 *   format              prettier --check on the changed files                      `pnpm format:check`
 *   dead-code           knip, cached in node_modules/.cache/knip                    the dead-code gate (Doctrine gates)
 *   procedure registry  each package's procedure-registry.mjs --check              procedure-registry.test.ts
 *   recorded calls, ui tokens, ops-desk catalog: the one test file, after the turbo-cached build its
 *                       package's tests need                                       the Tests job
 *   render record       render.compare.tsx, only on the parts the change most likely redraws (at most MAX_PARTS)
 * The lint ratchet, the wire replay, the journey-file scans and the size count stay in the hook itself. No typecheck and
 * no full test run: the box's CPU is why #9599 took them out, and CI's Typecheck and Tests jobs run them.
 *
 *   exit 0  every check that ran passed, or the checks ran past the limit (TIMEOUT: stopped; CI judges them)
 *   exit 1  a check failed: its output is printed, then the command that fixes it
 *
 *   node tooling/scripts/pre-push-changed.mjs [--base <commit>] [--limit <seconds>] [--refusals <file>] [--build-after <file>]
 *   --refusals writes the name of each check that refused, one a line, for the hook's list at the end.
 *   --build-after holds the turbo build (and the checks that need it) until that file exists: the hook creates it once
 *   its wire replay, which builds with turbo too, is done, so two builds never write the same packages at once. The
 *   checks that build nothing run meanwhile; the ones that wait get the whole limit from when it opens.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIMIT_SECONDS = 90;
/** The render parts one push may compare: each costs about a second, and the first few the module transforms (13 s for one). */
const MAX_PARTS = 8;
const RENDER_DIR = 'apps/customer/render-record';

const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const TEST = /\.(?:test|spec|node-test|compare)\.[cm]?[jt]sx?$/;

/** The extensions `pnpm format:check` checks, from package.json's format:check (`prettier --check "**\/*.{ts,...}"`). */
export function formatExtensions(script) {
  const m = /\{([^}]+)\}/.exec(script ?? '');
  return m ? m[1].split(',') : [];
}

/** Each package whose `procedures:write` writes its registry: its folder, and the `--check` arguments that script uses. */
export function registriesOf(packages) {
  const out = [];
  for (const { dir, json } of packages) {
    const write = json.scripts?.['procedures:write'];
    const m = write && /node (\S*procedure-registry\.mjs) (\S+) (\S+) (\S+)/.exec(write);
    if (m) out.push({ dir, name: json.name, script: m[1], args: [m[2], m[3], m[4]] });
  }
  return out;
}

const under = (files, re) => files.some((f) => re.test(f));

/**
 * The checks this push's changed files call for, each with what it runs and the command that fixes it. Pure: the
 * caller gives the files (all changed, and those still present) and what the repo holds.
 */
export function plan({ changed, present, formatExts, registries, has }) {
  const checks = [];
  const fmt = new RegExp(`\\.(?:${formatExts.join('|')})$`);
  const toFormat = present.filter((f) => fmt.test(f));
  if (formatExts.length && toFormat.length && has('node_modules/.bin/prettier'))
    checks.push({
      id: 'format',
      cmd: ['node_modules/.bin/prettier', '--check', ...toFormat],
      fix: `pnpm exec prettier --write ${toFormat.length <= 6 ? toFormat.join(' ') : '<the files above>'}`,
    });
  if (
    has('tooling/ci/dead-code.mjs') &&
    has('node_modules/knip/bin/knip.js') &&
    (under(changed, CODE) || changed.some((f) => /(?:^|\/)(?:package\.json|knip\.jsonc)$/.test(f)))
  )
    checks.push({
      id: 'dead-code',
      cmd: ['node', 'tooling/ci/dead-code.mjs', '--cache'],
      fix: 'delete each file or export named above, or drop its `export` (its line says which); check again: node tooling/ci/dead-code.mjs',
    });
  for (const r of registries)
    if (has('node_modules/.bin/prettier') && changed.some((f) => f.startsWith(`${r.dir}/src/`)))
      checks.push({
        id: `procedure registry (${r.name})`,
        cmd: ['node', r.script, ...r.args, '--check'],
        cwd: r.dir,
        fix: `pnpm --filter ${r.name} procedures:write`,
      });
  // The test checks build with turbo and run vitest: without this worktree's install the lint ratchet refuses first.
  const tests = has('node_modules/.bin/turbo');
  // Volt count, recorded calls and the render record read apps/customer/src (the render sweep also a helper beside the
  // journeys), never a journey file: a push of journey files alone builds nothing (project-state#3912).
  const customer = tests && under(changed, /^apps\/customer\/(?!tests\/real-app\/[^/]+\.pw\.mjs$)/);
  const ui = tests && under(changed, /^packages\/ui\//);
  const contracts = tests && under(changed, /^packages\/contracts\/src\//);
  const vitest = (id, pkg, file, fix, extra = []) => ({
    id,
    build: pkg,
    cmd: ['pnpm', '--filter', pkg, 'exec', 'vitest', 'run', file, ...extra],
    fix: `${fix}; check again: pnpm --filter ${pkg} exec vitest run ${file}`,
  });
  if ((customer || contracts) && has('apps/customer/src/app/recorded-calls.test.ts'))
    checks.push(
      vitest(
        'recorded calls',
        '@intafaced/customer',
        'src/app/recorded-calls.test.ts',
        'make each call named above with api.call(RECORD, input) from its record, not by its module and path strings',
      ),
    );
  // The hex scan reads packages/ui's components and the Customer app's screens and shell; the rest reads packages/ui's theme.
  if (
    tests &&
    under(changed, /^(?:packages\/ui\/src\/|apps\/customer\/src\/(?:screens|app)\/)/) &&
    has('packages/ui/src/theme/tokens.test.ts')
  )
    checks.push(
      vitest(
        'ui tokens',
        '@intafaced/ui',
        'src/theme/tokens.test.ts',
        'use a colour token from packages/ui/src/theme/tokens.ts in place of each hex in the files named above',
      ),
    );
  const catalogReads =
    tests &&
    (under(changed, /^apps\/admin\/src\/lib\//) ||
      contracts ||
      under(changed, /^services\/[^/]+\/src\/(?:router\.ts|router\/|routes\/|wire-replay\.golden\/)/));
  if (catalogReads && has('apps/admin/src/lib/ops-desk/catalog.test.ts'))
    checks.push(
      vitest(
        'ops-desk catalog',
        '@intafaced/admin',
        'src/lib/ops-desk/catalog.test.ts',
        "point each read named above at a query its service's router has, or add the query",
      ),
    );
  if ((customer || ui) && has('apps/customer/src/app/render-record/render.compare.tsx'))
    checks.push({
      id: 'render record',
      build: '@intafaced/customer',
      render: true,
      fix: 'pnpm --filter @intafaced/customer render:record, then commit the recordings it changes (they are the change in what people see)',
    });
  return checks;
}

// ── render record: which parts this change most likely redraws ──────────────────────────────────────────────────────

const unescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|&#xa0;/g, ' ')
    .replace(/&amp;/g, '&');

/** A recording's pieces: each class name, attribute value and text, as the page shows them. */
export function piecesOfRecording(html) {
  const out = new Set();
  for (const m of html.matchAll(/\s[\w:-]+="([^"]*)"/g)) {
    const v = unescape(m[1]).trim();
    if (v) out.add(v);
    for (const word of v.split(/\s+/)) if (word) out.add(word);
  }
  for (const m of html.matchAll(/>([^<]+)</g)) {
    const t = unescape(m[1]).trim();
    if (t) out.add(t);
  }
  return out;
}

/** A source text's pieces a page could show: its string literals and their words, JSX text and CSS class names. */
export function piecesOfSource(text) {
  const out = new Set();
  const add = (s) => {
    const t = s.trim();
    if (t.length >= 4 && /[A-Za-z]/.test(t) && !/^[./@]/.test(t)) out.add(t);
  };
  for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\\\n]){3,160})\1/g)) {
    const lit = m[2];
    for (const part of lit.split(/\$\{[^}]*\}/)) add(part);
    for (const word of lit.split(/\s+/)) if (/-/.test(word) || word.length >= 8) add(word);
  }
  for (const m of text.matchAll(/>\s*([^<>{}\n]*[A-Za-z][^<>{}\n]*?)\s*</g)) add(m[1]);
  for (const m of text.matchAll(/\.([A-Za-z][\w-]{2,})/g)) add(m[1]);
  return out;
}

/** A recording's file name as its part's name: `bank__transfers--standing-order-revision-0.html` is `/bank/transfers#standing-order-revision-0`. */
export function partOfFile(file) {
  const [base, state] = file.replace(/\.html$/, '').split('--');
  const route = base === 'root' ? '/' : `/${base.replaceAll('__', '/')}`;
  return state ? `${route}#${state}` : route;
}

/**
 * The recordings a change most likely redraws, most likely first: each source piece the change touches (its changed
 * lines count three times, the rest of its files once) scores the recordings that show it, rarer pieces more. A piece
 * most recordings show (the shell) picks none. At most `max`; none when the change shows in no recording's text.
 */
export function pickRecordings({ recordings, changedPieces, filePieces }, max = MAX_PARTS) {
  const df = new Map();
  for (const pieces of recordings.values()) for (const p of pieces) df.set(p, (df.get(p) ?? 0) + 1);
  const common = recordings.size / 2;
  const score = new Map();
  const credit = (pieces, weight) => {
    for (const p of pieces) {
      const n = df.get(p);
      if (!n || n > common) continue;
      for (const [file, has] of recordings) if (has.has(p)) score.set(file, (score.get(file) ?? 0) + weight / n);
    }
  };
  credit(changedPieces, 3);
  credit(filePieces, 1);
  return [...score]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([file]) => file);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/#-]/g, '\\$&');

/** vitest's `-t` for the parts named, plus the stale-recording check, which draws nothing. */
export const renderPattern = (parts) => `part by part (?:${parts.map(escapeRe).join('|')})$|records no part that no longer exists`;

function renderPlan(git, base, changed) {
  const sources = changed.filter(
    (f) => /^(?:apps\/customer\/src|packages\/ui\/src)\//.test(f) && /\.(?:tsx?|css|json)$/.test(f) && !TEST.test(f),
  );
  const recordings = new Map();
  for (const f of readdirSync(join(ROOT, RENDER_DIR)).filter((n) => n.endsWith('.html')))
    recordings.set(f, piecesOfRecording(readFileSync(join(ROOT, RENDER_DIR, f), 'utf8')));
  const changedPieces = new Set();
  const filePieces = new Set();
  for (const f of sources) {
    const hunks = git('diff', '-U0', '--no-color', base, 'HEAD', '--', f)
      .split('\n')
      .filter((l) => /^[+-](?![+-]{2})/.test(l))
      .join('\n');
    for (const p of piecesOfSource(hunks)) changedPieces.add(p);
    for (const at of [base, 'HEAD']) {
      let text = '';
      try {
        text = git('show', `${at}:${f}`);
      } catch {}
      for (const p of piecesOfSource(text)) filePieces.add(p);
    }
  }
  const picked = pickRecordings({ recordings, changedPieces, filePieces });
  // A route the look gate now draws with no recording fails as "not recorded": always compared.
  let unrecorded = [];
  try {
    const routes = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { sweepRoutes } from './tooling/ci/look-gate/rooms.mjs'; console.log(JSON.stringify(sweepRoutes()))",
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    );
    const known = new Set([...recordings.keys()].map(partOfFile));
    unrecorded = routes.filter((r) => !known.has(r));
  } catch {}
  return [...new Set([...unrecorded, ...picked.map(partOfFile)])];
}

// ── running ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs one command in its own process group, output held; resolves to { verdict: 'pass'|'fail'|'timeout', out }. */
function run([bin, ...args], { cwd = ROOT, deadline, env }) {
  return new Promise((resolve) => {
    const left = deadline - Date.now();
    if (left <= 0) return resolve({ verdict: 'timeout', out: '' });
    let out = '';
    const child = spawn(bin, args, { cwd: join(ROOT, cwd === ROOT ? '' : cwd), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      resolve({ verdict: 'timeout', out });
    }, left);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ verdict: code === 0 ? 'pass' : 'fail', out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ verdict: 'fail', out: `${out}${e.message}\n` });
    });
  });
}

async function main() {
  const flag = (name) => {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : undefined;
  };
  const limitSeconds = Number(flag('--limit') ?? LIMIT_SECONDS);
  const git = (...a) =>
    execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  let base;
  let changed;
  let present;
  try {
    base = flag('--base') ?? git('merge-base', 'origin/main', 'HEAD').trim();
    changed = git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean);
    present = git('diff', '--name-only', '--no-renames', '--diff-filter=ACMR', base, 'HEAD').split('\n').filter(Boolean);
  } catch {
    console.log('changed-file checks: git cannot say what this push changes; left to CI');
    return 0;
  }
  if (!changed.length) return 0;
  const has = (f) => existsSync(join(ROOT, f));
  const readJson = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
  const packages = has('packages') ? readdirSync(join(ROOT, 'packages')).filter((d) => has(`packages/${d}/package.json`)) : [];
  const checks = plan({
    changed,
    present,
    formatExts: has('package.json') ? formatExtensions(readJson('package.json').scripts?.['format:check']) : [],
    registries: registriesOf(packages.map((d) => ({ dir: `packages/${d}`, json: readJson(`packages/${d}/package.json`) }))),
    has,
  });
  if (!checks.length) return 0;

  const started = Date.now();
  const deadline = started + limitSeconds * 1000;
  const env = { ...process.env };
  for (const k of ['WIRE_REPLAY_WRITE', 'RENDER_RECORD', 'NODE_TEST_CONTEXT']) delete env[k];
  console.log(`changed-file checks: ${checks.map((c) => c.id).join(', ')}; limit ${limitSeconds}s`);

  // The packages the test checks import, from turbo's cache when main's (about a second); a changed package builds here.
  const builds = [...new Set(checks.map((c) => c.build).filter(Boolean))];
  const gate = flag('--build-after');
  let buildDeadline = deadline;
  const built = builds.length
    ? (async () => {
        // A hook stopped before it opens the gate (Ctrl-C) leaves no waiter behind: it gives up a minute after the limit.
        while (gate && !existsSync(gate) && Date.now() < deadline + 60_000) await new Promise((r) => setTimeout(r, 200));
        buildDeadline = Date.now() + limitSeconds * 1000;
        return run(['pnpm', 'turbo', 'run', 'build', '--output-logs=errors-only', ...builds.map((p) => `--filter=${p}^...`)], {
          deadline: buildDeadline,
          env,
        });
      })()
    : Promise.resolve({ verdict: 'pass', out: '' });
  const results = await Promise.all(
    checks.map(async (c) => {
      const t0 = Date.now();
      if (c.build) {
        const b = await built;
        if (b.verdict !== 'pass') return { c, ...b, out: `the packages its test reads did not build:\n${b.out}`, took: 0 };
      }
      let cmd = c.cmd;
      if (c.render) {
        const parts = renderPlan(git, base, changed);
        c.name = c.id;
        c.id = `render record (${parts.length ? parts.join(' ') : 'stale recordings only'})`;
        cmd = [
          'pnpm',
          '--filter',
          '@intafaced/customer',
          'exec',
          'vitest',
          'run',
          '--config',
          'vitest.render.config.ts',
          '-t',
          renderPattern(parts),
        ];
      }
      const r = await run(cmd, { cwd: c.cwd, deadline: c.build ? buildDeadline : deadline, env });
      return { c, ...r, took: Math.round((Date.now() - t0) / 1000) };
    }),
  );

  const took = Math.round((Date.now() - started) / 1000);
  const red = results.filter((r) => r.verdict === 'fail');
  const late = results.filter((r) => r.verdict === 'timeout');
  for (const r of red) {
    console.error(`\n  ✖ ${r.c.id} failed — push refused. CI runs the same check and would fail the same way:\n`);
    console.error(
      r.out
        .trimEnd()
        .split('\n')
        .slice(-60)
        .map((l) => `    ${l}`)
        .join('\n'),
    );
    console.error(`\n    Fix: ${r.c.fix}\n`);
  }
  for (const r of late)
    console.log(`changed-file checks: ${r.c.id} TIMEOUT after ${limitSeconds}s — stopped; the push goes on and CI judges it`);
  console.log(`changed-file checks: ${results.map((r) => `${r.c.id} ${r.verdict}${r.took ? ` ${r.took}s` : ''}`).join(', ')} (${took}s)`);
  const refusals = flag('--refusals');
  if (refusals && red.length) writeFileSync(refusals, red.map((r) => `${r.c.name ?? r.c.id}\n`).join(''));
  return red.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(await main());
