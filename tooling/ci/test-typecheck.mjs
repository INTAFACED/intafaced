#!/usr/bin/env node
/**
 * TYPE-CHECK THE TESTS — the only code in this repo that had no type gate.
 *
 * ── WHAT WAS ACTUALLY TRUE BEFORE THIS FILE ─────────────────────────────────
 *
 * Thirty-one of the thirty-two workspace tsconfigs carried this line:
 *
 *     "exclude": ["src/**\/*.test.ts", "dist", "node_modules"]
 *
 * and every `typecheck` script was `tsc -p tsconfig.json --noEmit`. So `tsc` was
 * told, in every package but one, not to look at a single test file. Vitest does
 * not close the gap: esbuild strips types without checking them. Between the two
 * there was no step anywhere — local or CI — that ever type-checked a test.
 *
 * The proof that this was not theoretical is one import block in
 * `packages/contracts/src/ops-analytics.test.ts`, which imported
 * `countMetricsUsingSource` twice, thirteen lines apart:
 *
 *     ops-analytics.test.ts(8,3):  error TS2300: Duplicate identifier …
 *     ops-analytics.test.ts(21,3): error TS2300: Duplicate identifier …
 *
 * `pnpm --filter @intafaced/contracts typecheck` exited 0 with that on disk. It
 * reached main because nothing could see it. `svc-academy`'s ladder suite had
 * six more of the same shape.
 *
 * ── WHY TESTS ARE THE WORST PLACE TO HAVE NO TYPE GATE ──────────────────────
 *
 * A test file is where a fixture encodes an assumption about a production type.
 * When the type moves and the fixture does not, the fixture is still a valid
 * JavaScript object, vitest still runs it, and the assertion still passes — it
 * just no longer exercises the thing it names. That is worse than a failing
 * test: it is a green tick over a proof that has quietly stopped applying. Most
 * of the pinned findings below are exactly that — `Property 'service' is missing
 * in type … but required in type 'Context'` is a `Context` fixture that drifted
 * away from `Context`.
 *
 * ── WHY A RATCHET AND NOT A CLEAN SWEEP ─────────────────────────────────────
 *
 * Switching the check on revealed 84 diagnostics across 16 packages. Fourteen of
 * them were the duplicate-identifier class named above, which is fixed in the
 * same change as this file because deleting a symbol imported twice cannot alter
 * behaviour. The remaining 70 are real type drift in fifteen packages —
 * including two with other agents live in them — and each needs a judgement
 * about whether the fixture or the production type is the wrong one. Bundling 70
 * such judgements into the change that installs the mechanism would produce a
 * diff nobody can review, and weakening the config to make it green would
 * install a gate that gates nothing, which is the defect being fixed.
 *
 * So: the mechanism lands enforcing, with today's failures pinned. This is the
 * pattern the repo already uses in `fabricated-money-scan` (12 frozen),
 * `vendor-java-money-scan` (55) and `wallet-rpc-mainnet-scan` (57). A NEW error
 * fails the build. A pinned one that gets FIXED also fails the build, telling
 * you to delete its row — so the list can only shrink, and it cannot rot into
 * blanket cover.
 *
 * ── WHY PINS CARRY NO LINE NUMBER, AND DO CARRY A COUNT ─────────────────────
 *
 * A pin keyed by line number breaks when someone adds an import above it, and a
 * gate that goes red for an unrelated edit gets switched off. So a pin is
 * `file | code | message`, which survives movement within a file.
 *
 * Dropping the line number would let a second identical error hide behind the
 * first, so each pin carries HOW MANY times it appears — the same reason
 * `wallet-rpc-mainnet-scan` freezes its constants by text *and* by count. Five
 * `Expected 2-3 arguments, but got 1` used to pin five call sites in
 * `router.mount.test.ts`; that pin was deleted when those sites passed the
 * instruments stub. A pin is `file | code | message` plus HOW MANY times it
 * appears — the same reason `wallet-rpc-mainnet-scan` freezes its constants by
 * text *and* by count.
 *
 * Absolute paths inside a message (TS6059 and TS7016 quote them) are rewritten
 * to `<repo>` so a pin means the same thing on a laptop and on a CI runner.
 *
 * ── HOW IT IS WIRED ─────────────────────────────────────────────────────────
 *
 * Not as a doctrine gate — this needs `^build` for cross-package types, which is
 * exactly what the turbo `typecheck` task already guarantees. Every package's
 * script is now:
 *
 *     tsc -p tsconfig.json --noEmit && node ../../tooling/ci/test-typecheck.mjs
 *
 * so `pnpm typecheck`, `pnpm verify` and CI all run it, in parallel, cached, with
 * the dependency graph already resolved. `tooling/ci/gates.mjs` lists it under
 * NOT_GATES with this reason.
 *
 * A package with NO `tsconfig.test.json` is not skipped: it must instead prove
 * that its own `tsconfig.json` does not exclude tests (which is how `apps/admin`
 * has always covered its four suites). Deleting a `tsconfig.test.json` to make
 * this quiet therefore fails too.
 *
 * Usage:
 *   node tooling/ci/test-typecheck.mjs           check the package in cwd
 *   node tooling/ci/test-typecheck.mjs --all     check every workspace package
 *   node tooling/ci/test-typecheck.mjs --report  print findings, never exit 1
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';

// ── The pinned set ──────────────────────────────────────────────────────────
//
// 62 diagnostics, hand-frozen at the commit that switched this check on
// (minus five router.mount stubs fixed when createP2pRouter gained options, and
// minus three mm/mid-source doubles that turned out to be hiding a money defect —
// see the note on `services/svc-trade` below).
// Each row is [howManyTimes, 'file | TScode | message'].
//
// THIS LIST MAY ONLY SHRINK. Fix an entry and delete its row in the same commit
// — the scan fails if a pin stops reproducing, so a stale pin cannot survive.
// Never add a row to silence a new error.
const PINNED = {
  // 5 — packages/contracts
  'packages/contracts': [
    [
      1,
      "src/contracts.test.ts | TS2741 | Property 'service' is missing in type '{ principal: null; region: string; requestId: string; }' but required in type 'Context'.",
    ],
    [
      1,
      "src/contracts.test.ts | TS2741 | Property 'service' is missing in type '{ principal: Principal; region: string; requestId: string; }' but required in type 'Context'.",
    ],
    [3, "src/raw-body.test.ts | TS2339 | Property 'bytes' does not exist on type 'ServiceRawBody'."],
  ],

  // 1 — packages/db
  'packages/db': [[1, "src/db.test.ts | TS2339 | Property 'dbCredentials' does not exist on type 'Config'."]],

  // 7 — services/svc-academy
  'services/svc-academy': [
    [
      2,
      "src/certs/xp-emit.test.ts | TS2345 | Argument of type '{ userId: string; certId: string; xpDelta: string; idempotencyKey: string; }' is not assignable to parameter of type 'XpEarnedIntent'.",
    ],
    // bulk-score.test seasonId-required pins retired after calendar-gate type tighten (W6 L02).
    [
      3,
      "src/tournaments/season-lifecycle.test.ts | TS2322 | Type 'SeasonRecord' is not assignable to type '{ status: \"scheduled\"; id: string; slug: string; title: string; rulesSummary: string; startsAt: Date; endsAt: null; }'.",
    ],
  ],

  // 5 — services/svc-agents
  'services/svc-agents': [
    [
      2,
      'src/crew-events.test.ts | TS2345 | Argument of type \'{ crewId: string; userId: string; role: string; crewSize: number; matchRunId: string; }\' is not assignable to parameter of type \'{ userId: string; crewId: string; role: "anchor" | "scout" | "builder" | "catalyst"; crewSize: number; matchRunId: string; }\'.',
    ],
    [3, "src/providers/providers.test.ts | TS2339 | Property 'message' does not exist on type 'ProviderError | CompletionResult'."],
  ],

  // 1 — services/svc-bank
  'services/svc-bank': [
    [
      1,
      "src/loans/loans.test.ts | TS2353 | Object literal may only specify known properties, and 'quality' does not exist in type 'Mark'.",
    ],
  ],

  // 1 — services/svc-dex
  'services/svc-dex': [[1, "src/quote/adapters.test.ts | TS2552 | Cannot find name 'RequestInfo'. Did you mean 'RequestInit'?"]],

  // 4 — services/svc-identity
  'services/svc-identity': [
    [
      1,
      "src/auth/webauthn.test.ts | TS1484 | 'AuthenticationResponseJSON' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.",
    ],
    [
      1,
      "src/auth/webauthn.test.ts | TS1484 | 'RegistrationResponseJSON' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.",
    ],
    [
      1,
      "src/auth/webauthn.test.ts | TS1484 | 'StoredWebAuthnCredential' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.",
    ],
    [
      1,
      "src/auth/webauthn.test.ts | TS2345 | Argument of type 'Map<unknown, unknown>' is not assignable to parameter of type 'CborValue'.",
    ],
  ],

  // 3 — services/svc-indexer
  'services/svc-indexer': [
    [1, "src/chain/evm/abi.test.ts | TS2339 | Property 'solcVersion' does not exist on type 'DevVenueArtifact'."],
    [
      1,
      "src/chain/evm/abi.test.ts | TS6059 | File '<repo>/services/svc-indexer/scripts/dev-venue.ts' is not under 'rootDir' '<repo>/services/svc-indexer/src'. 'rootDir' is expected to contain all source files.",
    ],
    [
      1,
      "src/chain/evm/abi.test.ts | TS7016 | Could not find a declaration file for module '../../../scripts/contract-sources.mjs'. '<repo>/services/svc-indexer/scripts/contract-sources.mjs' implicitly has an 'any' type.",
    ],
  ],

  // 1 — services/svc-ledger
  'services/svc-ledger': [[1, 'src/s2s-http.test.ts | TS2554 | Expected 4 arguments, but got 3.']],

  // 0 — services/svc-notify (Wave 13 L12: spawnSync arity fixed; pin deleted)
  'services/svc-notify': [],

  // 2 — services/svc-p2p
  'services/svc-p2p': [
    [
      1,
      'src/reputation.test.ts | TS2322 | Type \'["completed"] | readonly ["escrowed"]\' is not assignable to type \'[TradeOutcome, (number | undefined)?]\'.',
    ],
    [
      1,
      "src/reputation.test.ts | TS4104 | The type 'readonly [\"escrowed\"]' is 'readonly' and cannot be assigned to the mutable type '[TradeOutcome, (number | undefined)?]'.",
    ],
  ],

  // 9 — services/svc-pay (broadcast-store TS2352 pin retired — cast via unknown)
  'services/svc-pay': [
    [1, "src/ledger-client.test.ts | TS2552 | Cannot find name 'RequestInfo'. Did you mean 'RequestInit'?"],
    [4, "src/rails/posture.test.ts | TS2339 | Property 'message' does not exist on type 'Error | { txHash: string; }'."],
    [
      1,
      "src/rails/rails.test.ts | TS2345 | Argument of type '{ id: string; capabilities: readonly [\"authorize\"]; health: () => { healthy: boolean; latencyMs: number; lastUpdate: Date; }; authorize: (p: PaymentIntent) => Promise<RailResult>; capture: (ref: string) => Promise<RailResult>; refund: (ref: string, amount: Amount) => Promise<RailResult>; payout: (s: SettlementInstru...' is not assignable to parameter of type 'RailAdapter'.",
    ],
    [
      1,
      "src/rails/rails.test.ts | TS2741 | Property 'mode' is missing in type '{ id: string; capabilities: readonly [\"authorize\"]; health: () => { healthy: boolean; latencyMs: number; lastUpdate: Date; }; authorize: (p: PaymentIntent) => Promise<RailResult>; capture: (ref: string) => Promise<RailResult>; refund: (ref: string, amount: Amount) => Promise<RailResult>; payout: (s: SettlementInstru...' but required in type 'RailAdapter'.",
    ],
    [
      1,
      "src/router.test.ts | TS2741 | Property 'service' is missing in type '{ principal: null; region: string; requestId: string; }' but required in type 'Context'.",
    ],
    [
      1,
      "src/router.test.ts | TS2741 | Property 'service' is missing in type '{ principal: Principal; region: string; requestId: string; }' but required in type 'Context'.",
    ],
  ],

  // 3 — services/svc-protocol
  'services/svc-protocol': [
    [
      1,
      "src/chain/artifacts.test.ts | TS7016 | Could not find a declaration file for module '../../scripts/contract-sources.mjs'. '<repo>/services/svc-protocol/scripts/contract-sources.mjs' implicitly has an 'any' type.",
    ],
    [
      1,
      "src/launch/token-factory-onchain.test.ts | TS2352 | Conversion of type '{ eventName: string; args: readonly unknown[] | undefined; }' to type '{ eventName: string; args: Record<string, unknown>; }' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.",
    ],
    [
      1,
      "src/router.live-chain.test.ts | TS6059 | File '<repo>/services/svc-protocol/scripts/dev-chain.ts' is not under 'rootDir' '<repo>/services/svc-protocol/src'. 'rootDir' is expected to contain all source files.",
    ],
  ],

  // 1 — services/svc-trade
  //
  // Three `mm/mid-source.test.ts` pins are GONE rather than re-pinned, and they
  // were all one thing: adapter doubles returning `{ bids, asks }` and nothing
  // else, against a `snapshotBook` whose contract also requires `venueId`,
  // `symbol`, `sequence`, `sequenced` and `observedAt`.
  //
  // Worth a sentence because it was not a cosmetic type complaint. A double that
  // drops a required field cannot fail when the code under test drops it too, and
  // the dropped field here was `observedAt` — which is precisely how the
  // size-blind and age-blind mid in `createVenueMmMidSource` stayed invisible in
  // this suite while the identical defect was found and fixed twice in
  // `futures/mark-from-depth.ts` and `futures/mark-from-venue.ts`. The pins were
  // pointing at the blind spot the whole time.
  'services/svc-trade': [],

  // 14 — services/svc-ws
  // co-mount StubSource/hub-ctor pins cleared 2026-08-09 (#1342 typecheck-clean rewrite).
  'services/svc-ws': [],
};

// ── Plumbing ────────────────────────────────────────────────────────────────

const REPORT_ONLY = process.argv.includes('--report');

function repoRoot(from) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error('not inside the INTAFACED workspace');
    dir = up;
  }
}

const ROOT = repoRoot(process.cwd());
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** `packages/contracts` — the key PINNED uses, on any platform. */
function keyFor(dir) {
  return resolve(dir)
    .slice(ROOT.length + 1)
    .split(sep)
    .join('/');
}

/**
 * One tsc diagnostic as `file | code | message`.
 *
 * The line and column are dropped on purpose (see the header), and an absolute
 * path inside the message becomes `<repo>` so the pin is portable.
 */
function normalise(line) {
  const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
  if (!m) return null;
  const [, file, , , code, message] = m;
  const forward = message.split('\\').join('/');
  const portable = forward.split(ROOT.split('\\').join('/')).join('<repo>');
  return `${file.split('\\').join('/')} | ${code} | ${portable}`;
}

function run(dir) {
  const res = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.test.json'], { cwd: dir, encoding: 'utf8' });
  const out = ((res.stdout ?? '') + (res.stderr ?? '')).trim();

  const found = new Map();
  const unparsed = [];
  for (const raw of out.split('\n')) {
    if (!/error TS\d+/.test(raw)) continue;
    const key = normalise(raw);
    if (key === null) unparsed.push(raw.trim());
    else found.set(key, (found.get(key) ?? 0) + 1);
  }
  return { found, unparsed };
}

/**
 * A package with no `tsconfig.test.json` has to be covering its tests some other
 * way. `apps/admin` does — its own `include` takes `src/**\/*.ts(x)` and its
 * `exclude` names no test glob. Anything else is the hole this file closed
 * reopening itself.
 */
function coveredWithoutTestConfig(dir) {
  const raw = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
  // A tsconfig may carry comments; this only needs the exclude globs.
  const excludes = raw.match(/"exclude"\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';
  return !/\.test\.tsx?/.test(excludes) && !/\.spec\.tsx?/.test(excludes);
}

function hasTests(dir) {
  const stack = [join(dir, 'src')];
  while (stack.length > 0) {
    const at = stack.pop();
    if (!existsSync(at)) continue;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) stack.push(join(at, entry.name));
      else if (/\.(test|spec)\.tsx?$/.test(entry.name)) return true;
    }
  }
  return false;
}

/** @returns {string[]} problems */
function check(dir) {
  const key = keyFor(dir);
  const problems = [];

  if (!existsSync(join(dir, 'tsconfig.test.json'))) {
    if (!hasTests(dir)) return problems;
    if (coveredWithoutTestConfig(dir)) {
      console.log(`  ✓ ${key.padEnd(28)} tests covered by tsconfig.json itself`);
      return problems;
    }
    problems.push(
      `${key} has test files, no tsconfig.test.json, and a tsconfig.json that excludes tests.\n` +
        '      Nothing type-checks them. Add tsconfig.test.json (see any sibling package).',
    );
    return problems;
  }

  const { found, unparsed } = run(dir);
  for (const line of unparsed) problems.push(`${key}: tsc printed a diagnostic this scan could not parse:\n      ${line}`);

  const pinned = new Map((PINNED[key] ?? []).map(([count, sig]) => [sig, count]));

  for (const [sig, count] of found) {
    const allowed = pinned.get(sig) ?? 0;
    if (count > allowed) {
      problems.push(
        `${key} — ${count - allowed} NEW type error(s) in tests:\n` +
          `      ${sig}\n` +
          `      (seen ${count}×, pinned ${allowed}×)\n` +
          '      Fix the test or the type. Do NOT add a row to PINNED.',
      );
    }
  }

  for (const [sig, count] of pinned) {
    const actual = found.get(sig) ?? 0;
    if (actual < count) {
      problems.push(
        `${key} — a PINNED error no longer reproduces (good, the queue shrank):\n` +
          `      ${sig}\n` +
          `      (pinned ${count}×, now ${actual}×)\n` +
          `      Update that row in tooling/ci/test-typecheck.mjs — ${actual === 0 ? 'delete it' : `lower the count to ${actual}`}.`,
      );
    }
  }

  const total = [...found.values()].reduce((n, c) => n + c, 0);
  console.log(`  ${problems.length === 0 ? '✓' : '✖'} ${key.padEnd(28)} ${total === 0 ? 'clean' : `${total} pinned`}`);
  return problems;
}

// ── Run ─────────────────────────────────────────────────────────────────────

const targets = [];
if (process.argv.includes('--all')) {
  for (const area of ['packages', 'services', 'apps']) {
    const dir = join(ROOT, area);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (existsSync(join(dir, name, 'tsconfig.json'))) targets.push(join(dir, name));
    }
  }
  console.log(`\n══ TEST TYPECHECK (${targets.length} packages) ══\n`);
} else {
  targets.push(process.cwd());
}

const problems = targets.flatMap(check);

const frozenTotal = Object.values(PINNED).reduce((n, rows) => n + rows.reduce((m, [c]) => m + c, 0), 0);

if (problems.length > 0) {
  console.error('\n✖ TEST TYPECHECK\n');
  for (const p of problems) console.error(`  · ${p}\n`);
  console.error(
    `  ${frozenTotal} pre-existing test type error(s) are pinned in tooling/ci/test-typecheck.mjs.\n` +
      '  That list may only shrink. A red line above is either a new error or a fixed pin.\n',
  );
  if (!REPORT_ONLY) process.exit(1);
} else if (process.argv.includes('--all')) {
  console.log(`\n✓ no new test type errors — ${frozenTotal} pre-existing pinned, and the list can only shrink\n`);
}
