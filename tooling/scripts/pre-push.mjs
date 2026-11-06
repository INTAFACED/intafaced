#!/usr/bin/env node
/**
 * The pre-push checks: what CI's first run would refuse, caught on the machine before the push (plan 2026-11-06, "Now 3").
 *
 * Called by .githooks/pre-push with git's pushed refs on stdin. It runs, for the commit being pushed:
 *   1. the Doctrine gates (tooling/ci/gates.mjs, CI's `Doctrine gates` job), the shared ones several at a time beside 2;
 *   2. the typecheck of what CI's affected selection picks for this change (tooling/ci/ci-affected.mjs affectedFilters:
 *      the changed packages, their dependents and the readers in tooling/ci/test-read-edges.json), then the unit tests
 *      of the packages the push changes (turbo `--filter=[<merge-base>]`);
 *   3. the exclusive gates (money-property-mutation rewrites money.ts in place), alone, after 1 and 2.
 * A docs-only change runs the gates only, as CI does. The base is the merge-base with origin/main, as in CI.
 *
 * The escape is named and logged, never silent: INTAFACED_PRE_PUSH_SKIP="<why>" git push … skips these checks, prints
 * that it did, and writes the reason to the log below. Say so in the PR body. (`git push --no-verify` skips every hook
 * and logs nothing; do not use it.)
 *
 * Every run, pass, fail or skip, is one JSON line in <git common dir>/intafaced-pre-push.log, and each step's full
 * output is in <git dir>/intafaced-pre-push/<step>.log.
 *
 *   node tooling/scripts/pre-push.mjs --plan    print what a push of HEAD would run, and run nothing
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedFilters, classify, readEdges } from '../ci/ci-affected.mjs';

export const SKIP_ENV = 'INTAFACED_PRE_PUSH_SKIP';
const ZERO = /^0+$/;

/** A skip needs a reason a reader can act on: a bare flag value is refused. */
export function skipReason(env) {
  const raw = env[SKIP_ENV];
  if (raw === undefined) return { skip: false };
  const reason = String(raw).trim();
  if (reason.length < 8 || /^(1|true|yes|y|on|skip)$/i.test(reason))
    return { skip: false, refused: `${SKIP_ENV} needs a reason (8 characters or more), got "${raw}"` };
  return { skip: true, reason };
}

/** git's pre-push stdin: one `<local ref> <local sha> <remote ref> <remote sha>` line per pushed ref. */
export function parseRefs(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha, deletes: ZERO.test(localSha) }));
}

/**
 * What a push runs, from the files it changes against the merge-base. `docs`: gates only. `affected` and `full`: gates,
 * the typecheck of CI's affected selection, and the changed packages' unit tests. `gaps` names what CI runs and this
 * does not, for this change.
 */
export function planChecks(files, base, edges = readEdges()) {
  const flags = classify(files);
  const kind = flags.full ? 'full' : flags.affected ? 'affected' : 'docs';
  if (kind === 'docs') return { kind, typecheck: [], test: [], gaps: [] };
  const gaps = [];
  if (kind === 'full') {
    gaps.push(
      'CI builds, typechecks and tests the whole repo for this change (its run-everything list); this typechecks the affected selection and tests the changed packages only',
    );
  } else {
    gaps.push("CI also tests the changed packages' dependents and readers; this tests the changed packages only");
  }
  return { kind, typecheck: affectedFilters(files, edges, base), test: [`[${base}]`], gaps };
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function gitPath(args) {
  const p = git(args);
  return resolve(git(['rev-parse', '--show-toplevel']), p);
}

const elapsed = (ms) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;

/**
 * The environment the steps run in: this one without the variables git exports into a hook to locate this repository
 * (`git rev-parse --local-env-vars`: GIT_DIR, GIT_INDEX_FILE, …). With them, a gate that builds its own throwaway repo
 * (secret-scan-mutation, empty-denominator, the tooling tests) writes into this one instead and fails, which is not what
 * CI sees. Exported for its test.
 */
export function stepEnv(env, localVars) {
  const out = { ...env, FORCE_COLOR: '0' };
  for (const name of localVars) delete out[name];
  return out;
}

/**
 * The Mac-wide cap on heavy commands (a shared machine's slot script: `zsh <script> <command…>` waits for a free slot,
 * then runs the command). When it exists, the checks run inside one slot so pushes do not pile onto the load.
 * INTAFACED_HEAVY_WRAPPER names another script; set it to `none` to run without one.
 */
export function heavyWrapper(env, home, exists = existsSync) {
  const named = env.INTAFACED_HEAVY_WRAPPER;
  if (named === 'none') return null;
  const path = named || join(home, 'code', 'review', 'restart', 'heavy.sh');
  return exists(path) ? path : null;
}

/** The shared config's core settings a check must never change (2026-11-06: a gate's `git init` set core.bare). */
export const GUARDED_CONFIG = ['core.bare', 'core.hookspath', 'core.worktree'];

/** Names each guarded setting whose value differs between two snapshots. Exported for its test. */
export function configDrift(before, after) {
  return GUARDED_CONFIG.filter((k) => (before[k] ?? null) !== (after[k] ?? null)).map(
    (k) => `${k}: ${before[k] ?? '(unset)'} → ${after[k] ?? '(unset)'}`,
  );
}

function sharedConfig(commonDir) {
  const out = {};
  for (const k of GUARDED_CONFIG) {
    try {
      out[k] = execFileSync('git', ['config', '--file', join(commonDir, 'config'), '--get', k], { encoding: 'utf8' }).trim();
    } catch {
      out[k] = null;
    }
  }
  return out;
}

/** Runs one step with its output in a log file; resolves { ok, ms, log }. */
function step(name, cmd, args, { cwd, logDir, children, env }) {
  const log = join(logDir, `${name}.log`);
  const out = createWriteStream(log);
  const started = Date.now();
  console.log(`  … ${name}: ${[cmd, ...args].join(' ')}`);
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    children.add(child);
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', (code, signal) => {
      children.delete(child);
      out.end();
      const ms = Date.now() - started;
      const ok = code === 0;
      console.log(`  ${ok ? '✓' : '✖'} ${name} ${elapsed(ms)}${ok ? '' : signal ? ` (stopped by ${signal})` : ` (exit ${code})`}`);
      done({ name, ok, ms, log });
    });
  });
}

function tail(file, lines) {
  try {
    const all = readFileSync(file, 'utf8').trimEnd().split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(no output)';
  }
}

function writeRunLog(commonDir, entry) {
  try {
    appendFileSync(join(commonDir, 'intafaced-pre-push.log'), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error(`  (could not write the pre-push log: ${err.message})`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const planOnly = argv.includes('--plan');
  const top = git(['rev-parse', '--show-toplevel']);
  const commonDir = gitPath(['rev-parse', '--git-common-dir']);
  const gitDir = gitPath(['rev-parse', '--git-dir']);
  const head = git(['rev-parse', 'HEAD']);
  let branch = '';
  try {
    branch = git(['symbolic-ref', '--short', 'HEAD']);
  } catch {
    branch = '(detached)';
  }
  const at = new Date().toISOString();
  const refuse = (msg) => {
    console.error(
      `\n  ✖ pre-push checks: ${msg}\n\n    To push anyway, name why: ${SKIP_ENV}="<why>" git push …  (logged; say so in the PR body)\n`,
    );
    if (!planOnly) writeRunLog(commonDir, { at, event: 'refused', branch, head, why: msg });
    process.exit(1);
  };

  const refs = planOnly ? [] : parseRefs(readFileSync(0, 'utf8'));
  const pushed = refs.filter((r) => !r.deletes);

  const skip = planOnly ? { skip: false } : skipReason(process.env);
  if (skip.refused) refuse(skip.refused);
  if (skip.skip) {
    console.error(`\n  ⚠ pre-push checks SKIPPED (${SKIP_ENV}): ${skip.reason}`);
    console.error(`    Logged to ${join(commonDir, 'intafaced-pre-push.log')}. Say so in the PR body: CI will run what this did not.\n`);
    writeRunLog(commonDir, { at, event: 'skip', branch, head, refs: pushed.map((r) => r.remoteRef), reason: skip.reason });
    return;
  }

  if (!planOnly && pushed.length === 0) {
    console.log('  pre-push checks: nothing pushed but deletions; nothing to check');
    return;
  }
  // The checks read this worktree, so they can only vouch for a push of its HEAD with nothing uncommitted.
  for (const r of pushed) {
    if (r.localSha !== head)
      refuse(
        `${r.localRef} (${r.localSha.slice(0, 12)}) is not this worktree's HEAD (${head.slice(0, 12)}); the checks run on HEAD. Push from the worktree that has it checked out.`,
      );
  }
  const dirty = planOnly ? '' : git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty)
    refuse(
      `tracked files differ from HEAD, so the checks would read code you are not pushing:\n${dirty}\n    Commit them, or set them aside, then push.`,
    );
  if (!existsSync(join(top, 'node_modules', '.bin', 'turbo')))
    refuse('this worktree has no node_modules; run `pnpm install --frozen-lockfile` first (about 30 s).');

  let base;
  try {
    base = git(['merge-base', 'origin/main', 'HEAD']);
  } catch {
    refuse('cannot find the merge-base with origin/main; run `git fetch origin main`.');
  }
  const files = git(['diff', '--name-only', '--no-renames', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean);
  const plan = planChecks(files, base);
  const jobs = Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2)));
  const turbo = join(top, 'node_modules', '.bin', 'turbo');
  const tcArgs = ['run', 'typecheck', ...plan.typecheck.map((f) => `--filter=${f}`), '--output-logs=errors-only'];
  const testArgs = ['run', 'test', ...plan.test.map((f) => `--filter=${f}`), '--continue', '--concurrency=3', '--output-logs=errors-only'];

  console.log(
    `\n══ PRE-PUSH CHECKS — ${branch} @ ${head.slice(0, 12)}, ${files.length} file(s) changed since ${base.slice(0, 12)}: ${plan.kind} ══`,
  );
  for (const g of plan.gaps) console.log(`  (CI's job: ${g})`);
  if (planOnly) {
    console.log(`  gates: node tooling/ci/gates.mjs --jobs ${jobs} --part shared, then --part exclusive`);
    if (plan.kind !== 'docs') {
      console.log(`  typecheck: turbo ${tcArgs.join(' ')}`);
      console.log(`  test: turbo ${testArgs.join(' ')}`);
    } else console.log('  docs only: nothing to typecheck or test (as CI)');
    return;
  }

  const wrapper = process.env.INTAFACED_PRE_PUSH_IN_SLOT === '1' ? null : heavyWrapper(process.env, homedir());
  if (wrapper) {
    // The same checks again, inside one heavy slot; the inner run repeats the cheap checks above and does the rest.
    console.log(`  waiting for a heavy slot (${wrapper}) …`);
    const child = spawn('zsh', [wrapper, process.execPath, fileURLToPath(import.meta.url)], {
      cwd: top,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, INTAFACED_PRE_PUSH_IN_SLOT: '1' },
    });
    child.stdin.end(refs.map((r) => `${r.localRef} ${r.localSha} ${r.remoteRef} ${r.remoteSha}`).join('\n') + '\n');
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    const code = await new Promise((done) => child.on('close', (c) => done(c ?? 1)));
    process.exit(code);
  }

  const configBefore = sharedConfig(commonDir);
  const logDir = join(gitDir, 'intafaced-pre-push');
  mkdirSync(logDir, { recursive: true });
  const children = new Set();
  let interrupted = false;
  const stop = (sig) => {
    interrupted = true;
    for (const c of children) c.kill(sig);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const started = Date.now();
  const ctx = { cwd: top, logDir, children, env: stepEnv(process.env, git(['rev-parse', '--local-env-vars']).split('\n').filter(Boolean)) };
  const node = process.execPath;
  const results = [];
  const code = async () => {
    if (plan.kind === 'docs') {
      console.log('  docs only: nothing to typecheck or test (as CI)');
      return;
    }
    const tc = await step('typecheck', turbo, tcArgs, ctx);
    results.push(tc);
    if (interrupted) return;
    results.push(await step('test', turbo, testArgs, ctx));
  };
  const [gates] = await Promise.all([
    step('gates', node, ['tooling/ci/gates.mjs', '--jobs', String(jobs), '--part', 'shared'], ctx),
    code(),
  ]);
  results.unshift(gates);
  if (!interrupted) results.push(await step('gates-exclusive', node, ['tooling/ci/gates.mjs', '--part', 'exclusive'], ctx));

  // money-property-mutation restores money.ts in a `finally`, which a signal skips: put the copy it took back.
  const src = join(top, 'packages', 'ledger-client', 'src', 'money.ts');
  const backup = `${src}.mutation-backup`;
  if (existsSync(backup)) {
    copyFileSync(backup, src);
    rmSync(backup, { force: true });
    console.error("  restored packages/ledger-client/src/money.ts from the mutation gate's backup (it was stopped mid-run)");
  }

  const drift = configDrift(configBefore, sharedConfig(commonDir));
  if (drift.length) {
    results.push({ name: 'shared-config', ok: false, ms: 0, log: join(commonDir, 'config') });
    console.error(`\n  ✖ the shared git config (${join(commonDir, 'config')}) changed during the checks — every worktree reads it:`);
    for (const d of drift) console.error(`      ${d}`);
    console.error('    Put it back (git config --file <that file> <key> <old value>) and report which step did it.');
  }

  const ms = Date.now() - started;
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  writeRunLog(commonDir, {
    at,
    event: interrupted ? 'interrupted' : failed.length ? 'fail' : 'pass',
    branch,
    head,
    base,
    kind: plan.kind,
    files: files.length,
    seconds: Math.round(ms / 1000),
    failed,
  });
  if (interrupted) {
    console.error('\n  ✖ pre-push checks interrupted — push refused\n');
    process.exit(130);
  }
  if (failed.length) {
    for (const r of results.filter((x) => !x.ok && x.log.endsWith('.log'))) {
      console.error(`\n── ${r.name} failed — last lines (full output: ${r.log}) ──\n${tail(r.log, 60)}`);
    }
    console.error(`\n  ✖ pre-push checks failed (${failed.join(', ')}) in ${elapsed(ms)} — push refused. CI would go red on the same.`);
    console.error(`    Fix and push again. To push anyway, name why: ${SKIP_ENV}="<why>" git push …  (logged; say so in the PR body)\n`);
    process.exit(1);
  }
  console.log(`\n  ✓ pre-push checks passed in ${elapsed(ms)}\n`);
}

const RUN_AS_SCRIPT = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (RUN_AS_SCRIPT) {
  main().catch((err) => {
    console.error(`  ✖ pre-push checks crashed: ${err.stack || err}`);
    process.exit(1);
  });
}
