#!/usr/bin/env node
/**
 * THE EMPTY-DENOMINATOR LAW — a gate about gates.
 *
 * WHAT IT ENFORCES
 * ────────────────
 * A scan that walks nothing must REFUSE, not report clean. `✓ 0 problems` over
 * an empty file list is not evidence of health; it is the absence of evidence
 * wearing a tick.
 *
 * This is the repo's single most repeated defect. It has landed as a scan
 * walking zero files and printing clean; a dashboard querying a metric nobody
 * emitted; a gate registered and never run (`i18n-scan.mjs`, weeks, which is
 * why `gates.mjs` grew its manifest check); a test double omitting the field
 * production omits; and a latency grader returning a confident `'F'` for an
 * adapter no caller had ever invoked — a measured verdict on an unmeasured
 * thing, with the test asserting the verdict as intended.
 *
 * Seven gates had each learned it separately and independently hand-rolled a
 * guard: `brand-scan` (`scanned === 0`), `i18n-scan`, `i18n-bypass-scan`
 * ("walked zero un-allowlisted files and printed"), `wallet-rpc-mainnet-scan`
 * ("every denominator non-zero"), `event-wiring`, `shell-brand-scan`,
 * `vendor-java-money-scan`. Seven implementations of one rule, and NOTHING
 * enforcing it — so the eighth gate anyone wrote would not have it, because
 * nothing would ask.
 *
 * HOW IT PROVES IT — executed, not inspected
 * ──────────────────────────────────────────
 * Grepping for `scanned === 0` proves a string exists in a file. It does not
 * prove a gate refuses. So this gate RUNS every other gate against a tree
 * where its denominator is genuinely zero, and asserts what it actually did:
 *
 *   · a fixture tree is built containing ONLY a copy of `tooling/` — enough for
 *     a gate script and its sibling imports to load — plus an empty directory.
 *   · every gate is spawned from that copy with `cwd` set to the EMPTY dir.
 *     That zeroes both rooting styles at once, and they need different things:
 *     ~21 gates root at `process.cwd()`, so an empty cwd empties their subject;
 *     the rest root at `import.meta.url`, so only running the copy does.
 *     (Measured: run with `cwd` at the fixture root instead, `brand-scan`
 *     reports "clean — 76 files" because `tooling/` is itself in its scope. The
 *     empty cwd is what makes its denominator actually zero. `shell-brand` is
 *     the one gate that needs the other cwd — it reads `brand-scan.mjs`
 *     relative to ROOT to avoid restating the forbidden names, so under a bare
 *     cwd it dies on that read instead of reaching its own guard. Its row says
 *     `tree: 'tooling-only'` for exactly that reason.)
 *   · ENFORCED gates must exit non-zero AND match a pinned refusal, so a gate
 *     that loses its guard but still throws for some other reason is red too.
 *   · EXEMPT gates must exit ZERO in that same empty tree. That is the executed
 *     proof of the exemption itself: a gate whose subject travels with it in
 *     fixtures does not care that the repo is gone, and one that secretly
 *     depended on the repo would fail here and be exposed as misclassified.
 *   · BLIND gates are frozen debt — measured, named, printing clean over
 *     nothing today. Each row pins the exact clean line it emits, so FIXING one
 *     turns this gate red until its row is deleted. The list can only shrink.
 *
 * WHY THE CLASSIFICATION IS THE MECHANISM
 * ───────────────────────────────────────
 * Every entry in `GATES` must appear in exactly one of the four tables below.
 * An unclassified gate is a hard failure with no default — the same ratchet
 * shape `fabricated-money-scan` (deleted 2026-10-13), `vendor-java-money-scan`,
 * `wallet-rpc-mainnet-scan` and `test-typecheck` already use here. A new gate
 * cannot be silently skipped: it must be classified, and classifying it means
 * running it against nothing and looking at what it did. That is the whole
 * point. A meta-gate that quietly ignored gates it did not recognise would be
 * the very defect it polices.
 *
 * WHICH BRINGS US TO THE IRONY PROBLEM
 * ────────────────────────────────────
 * A gate about empty denominators is the most obvious candidate in this repo to
 * BE one. A version of this file that discovered zero gates and printed
 * `✓ all classified` would be perfect irony and worse than nothing, because it
 * would read as coverage. Three things stop that, all of them checks rather
 * than intentions:
 *
 *   1. the classified census is asserted against `GATES.length` from the real
 *      array — imported, not parsed out of source text — and against zero. A
 *      discovery bug cannot pass as an empty run.
 *   2. `selfProof()` runs on EVERY invocation, never behind a flag nobody
 *      types. It re-spawns this file against a substitute gate list — one with
 *      `GATES = []`, one with a single unclassified gate — and requires both to
 *      be refused. This is the `RULE_PROBES` precedent in
 *      `wallet-rpc-mainnet-scan`, and the `worktree-gc --self-test` precedent
 *      that became gate 28 because nothing ran it.
 *   3. this gate classifies ITSELF, as `SELF`. It cannot run in its own
 *      fixture — it would recurse — so `selfProof` is the executed stand-in,
 *      and that substitution is stated rather than hidden.
 *
 * HONEST LIMIT, stated because the alternative is implying coverage
 * ────────────────────────────────────────────────────────────────
 * Four ENFORCED gates refuse by UNCAUGHT throw, not by a guard: `secrets`,
 * `dual-book-door-paths`, `compose-secret-parity`,
 * `money-property-mutation`. A stack trace is a refusal — nobody reads
 * `ENOENT` as a clean bill of health — so they satisfy the law. But it is
 * WEAKER, and in a specific way worth naming: it proves the gate refuses when
 * its subject is MISSING, not when its subject exists and is EMPTY. Those rows
 * are marked `kind: 'uncaught'` and counted separately in the summary, so the
 * number is visible instead of blended into the strong ones.
 *
 * This gate polices GATES ONLY. Product code — where the latency grader lived —
 * is a much larger surface and needs a different mechanism. Not attempted here;
 * recorded as a residual.
 *
 * Usage:
 *   node tooling/ci/empty-denominator-gate.mjs           run it
 *   node tooling/ci/empty-denominator-gate.mjs --verbose print every verdict
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// Rooted at this file, NOT at cwd: this gate is spawned by gates.mjs from the
// repo root, but it also spawns ITSELF during selfProof, and a cwd-derived root
// would quietly follow the fixture.
const REPO = join(HERE, '..', '..');

/**
 * The substitute gate list seam, used ONLY by selfProof to hand this file a
 * census it must refuse. When set, the child skips its own selfProof — without
 * that, proof would recurse forever.
 */
const GATES_MODULE = process.env.EMPTY_DENOM_GATES_MODULE ?? join(REPO, 'tooling', 'ci', 'gates.mjs');
const IS_SELF_PROOF_CHILD = process.env.EMPTY_DENOM_GATES_MODULE !== undefined;
const VERBOSE = process.argv.includes('--verbose');

// ───────────────────────────────────────────────────────────────────────────
// 1. ENFORCED — proved to refuse when its denominator is zero.
//
// `must` is the refusal this gate is pinned to. It is asserted IN ADDITION to a
// non-zero exit, deliberately: exit code alone would let a gate lose its
// empty-scan guard and stay green here because it happened to throw somewhere
// else instead. Pinning the text means the guard itself is the thing under
// test.
//
// `kind: 'guard'`    — the gate names its own empty/absent subject and refuses.
// `kind: 'uncaught'` — the gate refuses by throwing. Counts, but see the header
//                      note on why it is weaker. Improving one of these to a
//                      real guard will break its row — that break is CORRECT
//                      and the fix is to update the row, which is a visible act.
// ───────────────────────────────────────────────────────────────────────────
export const ENFORCED = {
  tracker: {
    kind: 'guard',
    must: /TRACKER REGISTRY INVALID/,
    note: 'every `done` row is checked against files that must exist — an empty tree makes all 71 claims false rather than unverifiable.',
  },
  'services-map': {
    kind: 'guard',
    must: /SERVICES MAP FAILED - services\/ or docker-compose\.apps\.yml is missing/,
    note: 'refuses by name when services/ or the compose file is absent, instead of mapping nothing and calling it current.',
  },
  'truth-check': {
    kind: 'guard',
    must: /AGENTS\.md lost a core rule: file missing/,
    note: 'refuses by name when the agent entry files are absent, instead of reporting no stale rule over nothing.',
  },
  coverage: {
    kind: 'guard',
    must: /coverage-check: tooling\/coverage\.yaml does not exist/,
    note: 'refuses on the absent matrix by path instead of reporting 0 drift over 0 capabilities.',
  },
  reachability: {
    kind: 'guard',
    must: /REACHABILITY - \d+ protected module\(s\) were deleted/,
    note: 'the protected keep-list is what makes emptiness loud: no subject means every protected module reads as deleted.',
  },
  brand: {
    kind: 'guard',
    must: /BRAND SCAN FAILED — 0 files were read\. NOTHING WAS SCANNED\./,
    note: 'the canonical implementation of this law (brand-scan.mjs `scanned === 0`) and the reason the rule is worth generalising.',
  },
  boundary: {
    kind: 'guard',
    must: /BOUNDARY SCAN FAILED — scope is EMPTY/,
    note: 'refuses when it reads no source file or finds no service schemas, instead of reporting no violation over nothing.',
  },
  custody: {
    kind: 'guard',
    must: /CUSTODY SCAN FAILED — cannot read the module registry/,
    note: 'derives its service list from a registry; with no registry it declines to walk rather than walking nothing.',
  },
  s2s: {
    kind: 'guard',
    must: /S2S SCAN FAILED: cannot find services\//,
    note: 'a ratchet over services/ with no services/ to count; it refuses rather than reporting an empty tree as within its baseline.',
  },
  secrets: {
    kind: 'uncaught',
    must: /not a git repository/,
    note: 'enumerates via `git ls-files`, which fails hard outside a repo. Refuses, but by throw — no zero-file branch of its own.',
  },
  'invitation-outreach-golden': {
    kind: 'guard',
    must: /no outreach-\*\.golden\.js under/,
    note: 'a golden suite that finds no goldens is the textbook version of this defect; it refuses instead.',
  },
  killswitch: {
    kind: 'guard',
    must: /kill-switch reachability/,
    note: 'enumerates required routes by name, so absence is a named miss rather than an empty iteration.',
  },
  'screening-content': {
    kind: 'guard',
    must: /SCREENING CONTENT SCAN FAILED — packages\/config\/src\/screening\.ts is missing/,
    note:
      'Class X list-content boundary: with screening.ts gone it cannot prove the list is unshipped and refuses by name ' +
      'rather than printing clean over nothing.',
  },
  'marketing-language': {
    kind: 'guard',
    must: /MARKETING LANGUAGE SCAN FAILED — packages\/config\/src\/marketing-language\.ts is missing/,
    note:
      'DIRECTION §8.9 / D26-P0-16: with the law module gone it cannot prove audited/insured/guaranteed product copy is ' +
      'owner-sealed and refuses by name rather than printing clean over nothing.',
  },
  workspace: {
    kind: 'guard',
    must: /no service packages found, so checks 1-10 below each iterated an empty list/,
    note: 'the most explicit statement of this law in the repo: "This gate cannot pass on a tree it did not open."',
  },
  'event-wiring': {
    kind: 'guard',
    must: /there is no catalog to check/,
    note: 'one of the seven that learned this independently — the bus could not report silence, so now it refuses to.',
  },
  'skip-honesty': {
    kind: 'guard',
    must: /SKIP HONESTY SCAN FAILED/,
    note:
      'refuses via its stale-entry ratchet rather than a zero-file branch: with no tree, every tolerated-offender path ' +
      'is stale. Correct outcome, adjacent mechanism — recorded so nobody reads this row as a dedicated empty-scan guard.',
  },
  'money-skip-honesty': {
    kind: 'guard',
    must: /MONEY SKIP HONESTY FAILED/,
    note:
      'D26-P2-13 seal: with money roots absent it refuses "no money-path roots"; with roots that hold no test file it ' +
      'refuses on its own branch (paid rows only warn since 2026-10-27). Either way it cannot print clean over nothing.',
  },
  'compose-secret-parity': {
    kind: 'uncaught',
    must: /ENOENT[\s\S]*env\.ts/,
    note: 'reads packages/config/src/env.ts to learn which secrets exist. Refuses, by throw.',
  },
  'secret-rotation-readiness': {
    kind: 'guard',
    must: /SECRET ROTATION READINESS FAILED/,
    note:
      'D26-P3-05: denominator is the tip runbook. With the tree gone the file is missing and the scan refuses by name ' +
      'rather than printing clean over an absent inventory.',
  },
  'cross-package-reads': {
    kind: 'guard',
    must: /scope is EMPTY/,
    note: 'walks every workspace test file; with no test file anywhere it refuses by name instead of printing clean.',
  },
  'money-property-mutation': {
    kind: 'uncaught',
    must: /ENOENT[\s\S]*money\.ts/,
    note: 'copies its subject aside before mutating it, so an absent subject fails at the backup. Refuses, by throw.',
  },
};

// ───────────────────────────────────────────────────────────────────────────
// 2. EXEMPT — legitimately has no repo denominator, with a written reason.
//
// These carry their subject WITH them as fixtures, so there is no tree to be
// empty. The exemption is not taken on trust: each must still exit ZERO in the
// empty fixture tree, which is what proves the subject is internal. A gate that
// claimed exemption while actually reading the repo would fail here.
//
// MAY ONLY SHRINK. EXEMPT_MAX exists so that growing this list is an edit to a
// number with a reason beside it, not an append nobody reviews.
// ───────────────────────────────────────────────────────────────────────────
export const EXEMPT = {
  'gate-tools-tests': {
    // Spec reporter (Node 21+ default, this laptop): "ℹ pass N".
    // TAP reporter (Node 20 default, CI): "# pass N". Same count, earlier than the
    // "# skipped" / "# duration_ms" tail. Capture group 1 is that count.
    proof: /(?:ℹ|#) pass (\d+)/,
    denom: 1,
    reason:
      'node:test over in-memory fixtures (fixture JSON and log excerpts under tooling/scripts/fixtures, a fake gh and a fake ' +
      'git): the repo is not its subject. The count of passing tests is printed on every run and asserted non-zero here. ' +
      'CI Node 20 prints that count as TAP "# pass N"; Node 21+ prints spec "ℹ pass N". Both are the pass count. ' +
      'HONEST EXCEPTION: one test compares the dependabot prefix with the title rule; it reads the repo, and skips itself (reported as ' +
      'skipped, not passed) when the file is absent, which is exactly this empty-tree run. In a real checkout it runs.',
  },
  'secret-scan-mutation': {
    proof: /(\d+)\/(\d+) planted defects caught/,
    denom: 2,
    reason:
      'plants its own 13 credentials and 15 correct-but-credential-shaped files in a temp tree and runs the real scanner ' +
      'over them. The repo is not its subject — it passes 13/13 with the repo absent, which is this row proving itself.',
  },
};
// Raised 5 → 6 (2026-10-13) for gate-tools-tests, whose subject is its own fixtures; every earlier raise had the same reason.
// Lowered 6 → 2 (2026-10-19) with the retirement of the four tooling self-test gates (#5088).
export const EXEMPT_MAX = 2;

// ───────────────────────────────────────────────────────────────────────────
// 3. BLIND — measured, printing clean over nothing, frozen as debt.
//
// These are NOT exempt. Each has a real denominator and each reaches zero and
// still exits 0. They are recorded rather than fixed because fixing another
// gate's behaviour is out of scope for the change that added this file, and
// because a skip that turns into a refusal changes what happens in every
// checkout that legitimately lacks that tree — a decision per gate, not a
// sweep.
//
// `observed` pins the exact clean line each one emits today. So a gate that
// gets FIXED breaks its row and this gate goes red until the row is DELETED.
// The list can only shrink; that is the ratchet.
// ───────────────────────────────────────────────────────────────────────────
export const BLIND = {
  'test-db': {
    observed: /0 Postgres-capable test file\(s\) of 0 scanned/,
    reason: 'prints its zero denominator inside a ✓ line: "0 … of 0 scanned, all on *_test databases". All of nothing.',
  },
  migrations: {
    observed: /no services yet/,
    reason: 'clean on "no services yet" — true of a scaffold, indistinguishable from a services/ directory that stopped resolving.',
  },
};
// Lowered 4 → 2 (2026-10-19) with the vendor removal: wallet-rpc-auth and vendor-shell went with their subject.
export const BLIND_MAX = 2;

// ───────────────────────────────────────────────────────────────────────────
// 4. SELF — this gate, which cannot run inside its own fixture without
//    recursing. selfProof() below is the executed substitute.
// ───────────────────────────────────────────────────────────────────────────
export const SELF = 'empty-denominator';

// ── Census ─────────────────────────────────────────────────────────────────
/** Every gate classified exactly once, no stale rows, and the count non-zero. */
function census(gates) {
  const problems = [];
  const tables = [
    ['ENFORCED', Object.keys(ENFORCED)],
    ['EXEMPT', Object.keys(EXEMPT)],
    ['BLIND', Object.keys(BLIND)],
    ['SELF', [SELF]],
  ];

  const owner = new Map();
  for (const [table, ids] of tables) {
    for (const id of ids) {
      if (owner.has(id)) problems.push(`gate "${id}" is classified twice — in ${owner.get(id)} and in ${table}. One row per gate.`);
      else owner.set(id, table);
    }
  }

  const live = new Set(gates.map((g) => g.id));

  for (const id of live) {
    if (owner.has(id)) continue;
    problems.push(
      `gate "${id}" is in GATES but in none of ENFORCED / EXEMPT / BLIND.\n` +
        '      Run it against an empty tree and classify it by what it ACTUALLY did:\n' +
        '        · exits non-zero  → ENFORCED, with the refusal text pinned in `must`\n' +
        '        · exits 0, subject is its own fixtures → EXEMPT, with a written reason\n' +
        '        · exits 0, subject is the repo → BLIND, with the clean line pinned (and it is debt, not a pass)\n' +
        '      There is no default. A gate this file did not recognise is a gate it did not check, and\n' +
        '      silently skipping it would make THIS gate an instance of the defect it exists to police.',
    );
  }

  for (const [id, table] of owner) {
    if (!live.has(id))
      problems.push(
        `${table} lists "${id}", which is not in GATES any more. Delete the row — a classification for a gate that no longer exists is cover, not coverage.`,
      );
  }

  if (Object.keys(EXEMPT).length > EXEMPT_MAX)
    problems.push(
      `EXEMPT has ${Object.keys(EXEMPT).length} rows but EXEMPT_MAX is ${EXEMPT_MAX}. The exempt list may only shrink; raise the ratchet deliberately, in the same commit, with the reason.`,
    );
  if (Object.keys(BLIND).length > BLIND_MAX)
    problems.push(
      `BLIND has ${Object.keys(BLIND).length} rows but BLIND_MAX is ${BLIND_MAX}. The blind list may only shrink; a new gate should REFUSE on zero, not join the debt.`,
    );

  for (const [id, row] of Object.entries(EXEMPT)) {
    if (!row.reason || row.reason.length < 60)
      problems.push(`EXEMPT["${id}"] needs a written reason for having no denominator, not a placeholder.`);
  }
  for (const [id, row] of Object.entries(BLIND)) {
    if (!row.reason || row.reason.length < 60)
      problems.push(`BLIND["${id}"] needs a written reason recording what it prints over nothing.`);
  }

  // The anti-irony assertion. A discovery bug must not read as a clean run.
  if (gates.length === 0)
    problems.push(
      'GATES is EMPTY — this gate classified nothing and would have printed clean over zero gates. That is the defect this file exists to police, in this file.',
    );
  if (owner.size === 0) problems.push('no gates were classified at all. See above: an empty census is a failure, never a pass.');
  if (owner.size !== gates.length)
    problems.push(
      `classified ${owner.size} gate(s) but GATES has ${gates.length}. The census must equal the list exactly, so a discovery bug cannot pass as an empty run.`,
    );

  return problems;
}

// ── Fixture: a tree whose subject is genuinely empty ───────────────────────
function buildFixture() {
  const fix = mkdtempSync(join(tmpdir(), 'intafaced-empty-denominator-'));
  // `tooling/` only: enough for a gate script and its sibling imports to LOAD.
  // No services/, packages/, apps/, vendor/, docs/, no manifests — those are
  // the subjects, and their absence is the point.
  cpSync(join(REPO, 'tooling'), join(fix, 'tooling'), { recursive: true });
  mkdirSync(join(fix, 'empty'));
  return fix;
}

function runInEmptyTree(fix, gate, tree) {
  const cwd = tree === 'tooling-only' ? fix : join(fix, 'empty');
  // Stripped, not set to undefined: Node stringifies env values, so passing
  // `undefined` would hand the child the literal string "undefined".
  const env = { ...process.env };
  delete env.EMPTY_DENOM_GATES_MODULE;
  // realpath: on macOS tmpdir is often /var/folders → /private/var/folders.
  // Several self-test entries gate on `import.meta.url === pathToFileURL(argv[1])`
  // (claim-check isDirectRun). Passing the unresolved path makes that equality
  // false, the self-test never runs, and an EXEMPT row is mis-measured as a
  // refusal. Linux CI has no alias; realpath is a no-op there. Measured.
  const script = realpathSync(join(fix, gate.script));
  try {
    const out = execFileSync(process.execPath, [script, ...(gate.args ?? [])], {
      encoding: 'utf8',
      cwd,
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 'signal/timeout', out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

// ── selfProof: this gate, refusing its own empty denominator ───────────────
/**
 * Runs on EVERY invocation, not behind a flag. `worktree-gc --self-test` had to
 * become a GATES entry because nothing ran it, and #1151 shipped 15 fixtures
 * wired to nothing at all. The lesson taken here is that proof which needs
 * remembering is proof that does not exist.
 */
function selfProof(fix) {
  const cases = [
    {
      name: 'GATES = [] is refused (an empty census is never a pass)',
      module: 'export const GATES = [];\n',
      want: /GATES is EMPTY/,
    },
    {
      name: 'an unclassified gate is refused (no silent skip, no default)',
      module: "export const GATES = [{ id: 'a-gate-nobody-classified', script: 'tooling/ci/gates.mjs', doctrine: 'x', why: 'y' }];\n",
      want: /is in GATES but in none of ENFORCED \/ EXEMPT \/ BLIND/,
    },
  ];

  const results = [];
  for (const [i, c] of cases.entries()) {
    const mod = join(fix, `self-proof-${i}.mjs`);
    writeFileSync(mod, c.module);
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [join(HERE, 'empty-denominator-gate.mjs')], {
        encoding: 'utf8',
        cwd: REPO,
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, EMPTY_DENOM_GATES_MODULE: mod },
      });
    } catch (err) {
      code = err.status ?? 'signal/timeout';
      out = (err.stdout ?? '') + (err.stderr ?? '');
    }
    const refused = code !== 0;
    const matched = c.want.test(out);
    results.push({ name: c.name, ok: refused && matched, code, refused, matched });
  }
  return results;
}

// ── Run ────────────────────────────────────────────────────────────────────
const { GATES } = await import(pathToFileURL(GATES_MODULE).href);

const problems = [];
const censusProblems = census(GATES);
problems.push(...censusProblems);

// Census first, and only then the expensive part: a substitute-list child
// (selfProof) fails here and returns in milliseconds instead of building a
// fixture and running 32 gates for a verdict already decided.
let enforced = { guard: 0, uncaught: 0 };
let exemptOk = 0;
let blindOk = 0;
let proofs = [];
let fix;

if (censusProblems.length === 0) {
  fix = buildFixture();
  try {
    for (const gate of GATES) {
      if (gate.id === SELF) continue;

      const row = ENFORCED[gate.id] ?? EXEMPT[gate.id] ?? BLIND[gate.id];
      const { code, out } = runInEmptyTree(fix, gate, row.tree);
      const tail = out.trim().split('\n').filter(Boolean).slice(-3).join('\n        ');

      if (ENFORCED[gate.id]) {
        const r = ENFORCED[gate.id];
        if (code === 0) {
          problems.push(
            `ENFORCED gate "${gate.id}" EXITED 0 over an empty denominator — it reported on nothing and called it clean.\n` +
              `      Expected a refusal matching ${r.must}\n` +
              `      It printed:\n        ${tail}\n` +
              '      Either its empty-scan guard was removed (restore it), or it genuinely no longer refuses,\n' +
              '      in which case it is BLIND debt and must be moved to that table with the clean line pinned.',
          );
        } else if (!r.must.test(out)) {
          problems.push(
            `ENFORCED gate "${gate.id}" exited ${code} but its pinned refusal did not appear.\n` +
              `      Expected ${r.must}\n` +
              `      It printed:\n        ${tail}\n` +
              '      A non-zero exit for some OTHER reason is not proof that the empty-denominator guard still works.\n' +
              '      If the wording moved, update `must`. If the guard is gone, restore it.',
          );
        } else {
          enforced[r.kind] += 1;
          if (VERBOSE) console.log(`  ✓ ${gate.id.padEnd(28)} refused (exit ${code}, ${r.kind})`);
        }
      } else if (EXEMPT[gate.id]) {
        const r = EXEMPT[gate.id];
        if (code !== 0) {
          problems.push(
            `EXEMPT gate "${gate.id}" exited ${code} in an EMPTY tree, so its subject is NOT self-contained.\n` +
              `      It printed:\n        ${tail}\n` +
              '      The exemption claims it has no repo denominator. It evidently has one. Reclassify it.',
          );
        } else if (!r.proof.test(out)) {
          problems.push(
            `EXEMPT gate "${gate.id}" exited 0 but did not print the work its exemption rests on.\n` +
              `      Expected ${r.proof}\n      It printed:\n        ${tail}`,
          );
        } else {
          const m = out.match(r.proof);
          if (r.denom !== undefined && !(Number(m[r.denom]) > 0)) {
            problems.push(
              `EXEMPT gate "${gate.id}" printed a fixture denominator of ${m[r.denom]}. Zero fixtures is the same defect, one level in.`,
            );
          } else {
            exemptOk += 1;
            if (VERBOSE) console.log(`  ○ ${gate.id.padEnd(28)} exempt, subject self-carried${r.denom ? ` (${m[r.denom]} fixtures)` : ''}`);
          }
        }
      } else {
        const r = BLIND[gate.id];
        if (code !== 0 || !r.observed.test(out)) {
          problems.push(
            `BLIND gate "${gate.id}" no longer prints clean over nothing (exit ${code}).\n` +
              `      Frozen line was ${r.observed}\n      It printed:\n        ${tail}\n` +
              '      If it now REFUSES: good — DELETE its BLIND row and add it to ENFORCED. This list may only shrink,\n' +
              '      and this red is what makes the improvement a visible act instead of a silent one.',
          );
        } else {
          blindOk += 1;
          if (VERBOSE) console.log(`  ⚠ ${gate.id.padEnd(28)} BLIND — exits 0 over a zero denominator`);
        }
      }
    }

    if (!IS_SELF_PROOF_CHILD) {
      proofs = selfProof(fix);
      for (const p of proofs) {
        if (p.ok) continue;
        problems.push(
          `SELF-PROOF FAILED: ${p.name}\n` +
            `      exit=${p.code} refused=${p.refused} message-matched=${p.matched}\n` +
            '      This gate must refuse its OWN empty denominator. Until this passes, nothing above is trustworthy:\n' +
            '      a meta-gate that walks zero gates and prints clean is the defect it exists to police.',
        );
      }
    }
  } finally {
    if (fix) rmSync(fix, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error('\n✖ EMPTY-DENOMINATOR LAW BROKEN\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  console.error('  A check that reports on nothing is not evidence. It is the absence of evidence, wearing a tick.\n');
  process.exit(1);
}

const total = Object.keys(ENFORCED).length + Object.keys(EXEMPT).length + Object.keys(BLIND).length + 1;
const proofLine = IS_SELF_PROOF_CHILD
  ? 'self-proof skipped (substitute-list child)'
  : `self-proof ${proofs.filter((p) => p.ok).length}/${proofs.length}`;

console.log(
  `✓ empty-denominator — ${total}/${GATES.length} gates classified, none skipped · ` +
    `${enforced.guard + enforced.uncaught} refused a zero denominator when run against one ` +
    `(${enforced.guard} by explicit guard, ${enforced.uncaught} by uncaught throw — weaker, see header) · ` +
    `${exemptOk} exempt and proved self-carried · ${blindOk} frozen BLIND (debt, may only shrink) · ${proofLine}`,
);
