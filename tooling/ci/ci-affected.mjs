#!/usr/bin/env node
/**
 * CI affected-path classifier.
 *
 * Maps a changed-file list onto named test shards so a protocol PR fails as
 * `Tests (protocol)` instead of one 10-minute `Tests` blob.
 *
 *   node tooling/ci/ci-affected.mjs --self-test
 *   node tooling/ci/ci-affected.mjs --files services/svc-protocol/src/x.ts
 *   node tooling/ci/ci-affected.mjs --github-output
 *   node tooling/ci/ci-affected.mjs --seal
 *
 * `push:main` always classifies as full (the trunk seal). Tooling / lockfile /
 * shared contracts/events/ledger-client/config also force full so a consumer shard cannot be skipped.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SHARDS = {
  protocol: ['services/svc-protocol/', 'services/svc-dex/', 'services/svc-indexer/', 'services/svc-chain/', 'services/svc-bridge/'],
  money: ['services/svc-ledger/', 'services/svc-identity/', 'services/svc-token/'],
  trade: ['services/svc-trade/', 'services/svc-matching/', 'services/svc-execution/', 'packages/venue-adapter/', 'services/svc-ws/'],
  paybank: ['services/svc-pay/', 'services/svc-bank/', 'services/svc-p2p/'],
};

/** Shared types / CI / lockfile — consumers live in every shard. */
export const FULL_TRIGGERS = [
  'tooling/',
  '.github/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'INTAFACED_DEFINITIVE_BUILD.md',
  'packages/contracts/',
  'packages/events/',
  // Imported by dozens of services across every shard (27 workspaces depend on
  // ledger-client, 33 on config), so a change here must retest all of them.
  'packages/ledger-client/',
  'packages/config/',
];

const SHARD_KEYS = /** @type {const} */ (['protocol', 'money', 'trade', 'paybank']);

function posix(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function matchesPrefix(file, prefix) {
  const f = posix(file);
  const p = posix(prefix);
  if (p.endsWith('/')) return f === p.slice(0, -1) || f.startsWith(p);
  return f === p || f.startsWith(`${p}/`);
}

export function classify(files, { forceFull = false } = {}) {
  const out = {
    protocol: false,
    money: false,
    trade: false,
    paybank: false,
    rest: false,
    full: Boolean(forceFull),
  };
  if (out.full) return out;

  const list = (files || []).map(posix).filter(Boolean);
  for (const file of list) {
    if (file.startsWith('docs/') || file.endsWith('.md')) continue;
    if (FULL_TRIGGERS.some((t) => matchesPrefix(file, t))) {
      out.full = true;
      return out;
    }
  }

  for (const file of list) {
    if (file.startsWith('docs/') || file.endsWith('.md')) continue;
    let hit = false;
    for (const key of SHARD_KEYS) {
      if (SHARDS[key].some((p) => matchesPrefix(file, p))) {
        out[key] = true;
        hit = true;
      }
    }
    if (!hit && /^(apps|services|packages)\//.test(file)) out.rest = true;
  }

  // Unknown product paths run the full suite — never a silent skip.
  if (out.rest) {
    return { protocol: false, money: false, trade: false, paybank: false, rest: false, full: true };
  }

  const shardHits = SHARD_KEYS.filter((k) => out[k]).length;
  if (shardHits >= 3) {
    return { protocol: false, money: false, trade: false, paybank: false, rest: false, full: true };
  }
  return out;
}

export function sealNeeded(flags, results) {
  const problems = [];
  const always = ['changes', 'gates', 'format', 'build'];
  for (const name of always) {
    const r = results[name];
    if (r !== 'success') problems.push(`${name} was ${r || 'missing'} (required)`);
  }
  if (flags.full) {
    if (results['tests-full'] !== 'success') {
      problems.push(`tests-full was ${results['tests-full'] || 'missing'} (full run required)`);
    }
    return problems;
  }
  const map = {
    protocol: 'tests-protocol',
    money: 'tests-money',
    trade: 'tests-trade',
    paybank: 'tests-paybank',
    rest: 'tests-rest',
  };
  for (const [flag, job] of Object.entries(map)) {
    if (!flags[flag]) continue;
    if (results[job] !== 'success') problems.push(`${job} was ${results[job] || 'missing'} (${flag} shard required)`);
  }
  return problems;
}

function gitChangedFiles() {
  const baseRef = process.env.GITHUB_BASE_REF;
  const base = baseRef ? `origin/${baseRef}` : 'origin/main';
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    const out = execFileSync('git', ['diff', '--name-only', `${base}`], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function selfTest() {
  const empty = { protocol: false, money: false, trade: false, paybank: false, rest: false, full: false };
  const cases = [
    {
      files: ['services/svc-protocol/src/audit/pipeline.ts'],
      expected: { ...empty, protocol: true },
    },
    {
      files: ['packages/ledger-client/src/index.ts'],
      expected: { ...empty, full: true },
    },
    {
      files: ['packages/config/src/index.ts'],
      expected: { ...empty, full: true },
    },
    {
      files: ['services/svc-token/src/token-service.ts'],
      expected: { ...empty, money: true },
    },
    {
      files: ['services/svc-protocol/x.ts', 'services/svc-ledger/src/x.ts'],
      expected: { ...empty, protocol: true, money: true },
    },
    {
      files: ['tooling/ci/gates.mjs'],
      expected: { ...empty, full: true },
    },
    {
      files: ['pnpm-lock.yaml'],
      expected: { ...empty, full: true },
    },
    {
      files: ['packages/contracts/src/x.ts'],
      expected: { ...empty, full: true },
    },
    {
      files: ['apps/web/src/x.ts'],
      expected: { ...empty, full: true },
    },
    {
      files: ['docs/x.md'],
      expected: empty,
    },
    {
      files: ['services/svc-protocol/a.ts', 'services/svc-ledger/a.ts', 'services/svc-trade/a.ts'],
      expected: { ...empty, full: true },
    },
  ];
  for (const c of cases) {
    const got = classify(c.files);
    assert(same(got, c.expected), `classify(${JSON.stringify(c.files)}) => ${JSON.stringify(got)} expected ${JSON.stringify(c.expected)}`);
  }
  const forced = classify(['services/svc-protocol/x.ts'], { forceFull: true });
  assert(forced.full === true && forced.protocol === false, 'forceFull must short-circuit to full');

  const sealOk = sealNeeded(
    { full: false, protocol: true, money: false, trade: false, paybank: false, rest: false },
    {
      changes: 'success',
      gates: 'success',
      format: 'success',
      build: 'success',
      'tests-protocol': 'success',
    },
  );
  assert(sealOk.length === 0, `seal ok: ${sealOk}`);
  const sealFail = sealNeeded(
    { full: false, protocol: true, money: false, trade: false, paybank: false, rest: false },
    {
      changes: 'success',
      gates: 'success',
      format: 'success',
      build: 'success',
      'tests-protocol': 'failure',
    },
  );
  assert(sealFail.length === 1, `seal fail: ${sealFail}`);
  console.log(`✓ ci-affected --self-test OK (${cases.length + 3} fixtures)`);
}

function githubOutput(flags) {
  const lines = Object.entries(flags).map(([k, v]) => `${k}=${v ? 'true' : 'false'}`);
  const dest = process.env.GITHUB_OUTPUT;
  if (dest) writeFileSync(dest, `${lines.join('\n')}\n`, { flag: 'a' });
  for (const line of lines) console.log(line);
}

function runSeal() {
  const flags = {
    full: process.env.FULL === 'true',
    protocol: process.env.PROTOCOL === 'true',
    money: process.env.MONEY === 'true',
    trade: process.env.TRADE === 'true',
    paybank: process.env.PAYBANK === 'true',
    rest: process.env.REST === 'true',
  };
  const results = {
    changes: process.env.CHANGES,
    gates: process.env.GATES,
    format: process.env.FORMAT,
    build: process.env.BUILD,
    'tests-full': process.env.T_FULL,
    'tests-protocol': process.env.T_PROTOCOL,
    'tests-money': process.env.T_MONEY,
    'tests-trade': process.env.T_TRADE,
    'tests-paybank': process.env.T_PAYBANK,
    'tests-rest': process.env.T_REST,
  };
  const problems = sealNeeded(flags, results);
  if (problems.length) {
    console.error('✖ CI merge seal failed:');
    for (const p of problems) {
      console.error(`  - ${p}`);
      console.error(`::error title=CI merge seal::${p}`);
    }
    process.exit(1);
  }
  console.log('✓ CI merge seal: required jobs succeeded');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    process.exit(0);
  }
  if (args.includes('--seal')) {
    runSeal();
    process.exit(0);
  }

  const filesIdx = args.indexOf('--files');
  let files;
  let forceFull = process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_EVENT_NAME === 'push';
  if (filesIdx >= 0) files = args.slice(filesIdx + 1);
  else files = gitChangedFiles();
  const flags = classify(files, { forceFull });
  if (args.includes('--github-output')) githubOutput(flags);
  else console.log(JSON.stringify({ files, flags }, null, 2));
}
