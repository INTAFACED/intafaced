// Records, from `@intafaced/ledger-client`'s gate (`packages/ledger-client/src/gate/`) in this checkout, what the Rust
// ledger's posting door is held to:
//
// - `src/posting/recorded.rs`: the recipe gate's catalog (`recipeCatalogRows`, `recipe-gate.ts`), who may post which
//   recipe in which module (`LEDGER_POST_ALLOWLIST`, `caller-allowlist.ts`), the recipes only a proven key may post
//   (`KEY_REQUIRED_RECIPES`, `caller-judge.ts`), and the account prefixes whose balance is held as a negative
//   (`accounts.ts`).
// - `src/door/callers.rs`: which services may call each service door (`LEDGER_DOOR_CALLERS`, `door-callers.ts`).
// - `tests/fixtures/posting-parity/`: what the TypeScript answers for every recipe the gate was sampled from, and for
//   variants of each: the gate's candidates, every caller's allowlist verdict, `assertValidPost`'s refusal,
//   `postFingerprint`, `hashTx`, `movesCustomerBalance`, and the balance rule on each leg's account. `meta.json` holds the
//   callers in verdict order and the replay-meta cases; `cases-NN.jsonl` one recorded post a line, in parts small enough
//   for the CI review to read each whole.
//
// Run from the repository root:
//   TZ=UTC node --import tsx crates/svc-ledger/scripts/record-posting.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-ledger/scripts/record-posting.mjs --check  fails when a written file is stale
//
// The gate is the one place a grant, a door's callers or a recipe's legs change: change it there, run this, and commit
// both. CI's Rust job runs `--check`, so a gate change whose recorded tables were not rewritten fails there.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const NAME = 'record-posting';
const CHECK = process.argv.includes('--check');
if (process.env.TZ !== 'UTC') {
  console.error(`${NAME}: run with TZ=UTC`);
  process.exit(2);
}

// Literal paths, so the dead-code scan (knip.jsonc) sees what this reads.
const lc = await import('../../../packages/ledger-client/src/index.ts');
const { recipeCatalogRows, recipeGateSamples, recipeCandidates } = await import('../../../packages/ledger-client/src/gate/recipe-gate.ts');
const { LEDGER_POST_ALLOWLIST } = await import('../../../packages/ledger-client/src/gate/caller-allowlist.ts');
const { KEY_REQUIRED_RECIPES, judgeCallerPost } = await import('../../../packages/ledger-client/src/gate/caller-judge.ts');
const { LEDGER_DOOR_CALLERS } = await import('../../../packages/ledger-client/src/gate/door-callers.ts');

// ── The recorded tables ────────────────────────────────────────────────────────────────────────────────────────────

const catalog = recipeCatalogRows();
const allowlist = Object.entries(LEDGER_POST_ALLOWLIST).map(([service, grants]) => [
  service,
  Object.entries(grants)
    .filter(([, grant]) => grant)
    .map(([recipe, grant]) => [recipe, grant.module]),
]);
const keyRequired = [...KEY_REQUIRED_RECIPES].sort();
const heldNegative = [...lc.OWN_FUNDS_PLACE_PREFIXES, lc.CHARGE_RECEIVABLE_PREFIX, lc.PARTNER_FEE_RECEIVABLE_PREFIX];

// ── The parity cases ───────────────────────────────────────────────────────────────────────────────────────────────

const wire = (post) => ({
  idempotencyKey: post.idempotencyKey,
  module: post.module,
  reason: post.reason,
  entries: post.entries.map((e) => ({ account: e.account, direction: e.direction, amount: lc.formatAmount(e.amount) })),
  ...(post.meta ? { meta: post.meta } : {}),
});

/** A refusal as `{ code, message }`, or null when the call returns. */
function refusal(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return { code: err.code ?? null, message: err.message };
  }
}

const SERVICES = [...allowlist.map(([s]) => s), 'svc-unknown'];
/** A verdict as one line: `ok <recipe or ->`, or `<code> <reason> <recipe or ->`. */
const said = (j) => (j.ok ? `ok ${j.recipe ?? '-'}` : `${j.violation.code} ${j.violation.reason} ${j.violation.recipe ?? '-'}`);
/** Each caller's verdict, in `SERVICES` order, then an unclaimed shared-secret caller's. */
function verdicts(body) {
  const out = [];
  for (const service of SERVICES) {
    out.push(said(judgeCallerPost({ kind: 'bound', service }, body)));
  }
  out.push(said(judgeCallerPost({ kind: 'legacy', claimed: null }, body)));
  return out;
}

const TX_ID = '9a9a9a9a-0000-4000-8000-000000000001';
const POSTED_AT = new Date(Date.UTC(2026, 10, 21, 1, 2, 3, 45));
const accountId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function caseOf(label, post) {
  const body = wire(post);
  const entries = post.entries.map((e, i) => ({
    id: String(i + 1),
    txId: TX_ID,
    accountId: accountId(i),
    assetId: e.account.assetId,
    direction: e.direction,
    amount: e.amount,
    balanceAfter: 0n,
  }));
  const hashed = { id: TX_ID, module: post.module, reason: post.reason, postedAt: POSTED_AT, entries };
  return {
    label,
    body,
    candidates: recipeCandidates(body),
    verdicts: verdicts(body),
    valid: refusal(() => lc.assertValidPost(post)),
    fingerprint: lc.postFingerprint(post),
    hash: lc.hashTx(hashed, null),
    chained: lc.hashTx(hashed, 'f'.repeat(64)),
    customer: lc.movesCustomerBalance(post.entries),
    allowed: post.entries.map((e) => [-1n, 0n, 1n].map((n) => lc.balanceAllowed(e.account, n))),
    held: post.entries.map((e) => lc.formatAmount(lc.heldForRefusal(e.account, -5n))),
  };
}

const samples = recipeGateSamples();
const cases = [];
samples.forEach(({ name, post }, i) => {
  cases.push(caseOf(`${name} #${i}`, post));
  // The same legs under another module or reason, reversed, one leg short, and with one leg's owner and purpose moved.
  cases.push(caseOf(`${name} #${i}: another module`, { ...post, module: `${post.module}x` }));
  cases.push(caseOf(`${name} #${i}: another reason`, { ...post, reason: `${post.reason}.x` }));
  if (post.entries.length > 1) cases.push(caseOf(`${name} #${i}: reversed`, { ...post, entries: [...post.entries].reverse() }));
  if (post.entries.length > 2) cases.push(caseOf(`${name} #${i}: one leg short`, { ...post, entries: post.entries.slice(0, -1) }));
  const [first, ...rest] = post.entries;
  if (first) {
    const moved = {
      ...first.account,
      ownerId: `${first.account.ownerId}:z`,
      purpose: first.account.purpose ? ` ${first.account.purpose}x ` : undefined,
    };
    cases.push(caseOf(`${name} #${i}: first leg moved`, { ...post, entries: [{ ...first, account: moved }, ...rest] }));
  }
});

// Bodies the samples never make: every refusal of `assertValidPost`, in its order.
const U = '11111111-1111-4111-8111-111111111111';
const avail = (ownerId, assetId = 'USDT', ownerType = 'user') => ({ ownerType, ownerId, assetId, kind: 'available' });
const leg = (account, direction, amount) => ({ account, direction, amount: lc.parseAmount(amount) });
const base = { idempotencyKey: 'parity:handmade', module: 'test', reason: 'test.x' };
const HANDMADE = [
  [
    'short key',
    { ...base, idempotencyKey: 'short', entries: [leg(avail(U), 'credit', '1'), leg(avail('fees:trade', 'USDT', 'house'), 'debit', '1')] },
  ],
  ['one leg', { ...base, entries: [leg(avail(U), 'credit', '1')] }],
  ['zero leg', { ...base, entries: [leg(avail(U), 'credit', '0'), leg(avail('fees:trade', 'USDT', 'house'), 'debit', '0')] }],
  ['unbalanced', { ...base, entries: [leg(avail(U), 'credit', '1.5'), leg(avail('fees:trade', 'USDT', 'house'), 'debit', '1')] }],
  [
    'unbalanced in two assets',
    {
      ...base,
      entries: [
        leg(avail(U, 'BTC'), 'credit', '0.000000000000000001'),
        leg(avail(U), 'credit', '2'),
        leg(avail('fees:trade', 'USDT', 'house'), 'debit', '1'),
      ],
    },
  ],
  [
    'upper-case uuid',
    { ...base, entries: [leg(avail(U.toUpperCase()), 'credit', '1'), leg(avail('fees:trade', 'USDT', 'house'), 'debit', '1')] },
  ],
  [
    'uuid as house',
    { ...base, entries: [leg(avail(U), 'credit', '1'), leg(avail('a1111111-1111-4111-8111-111111111111', 'USDT', 'house'), 'debit', '1')] },
  ],
  ['bare number owner', { ...base, entries: [leg(avail(U), 'credit', '1'), leg(avail('1042', 'USDT', 'house'), 'debit', '1')] }],
  [
    'unfunded hold',
    {
      ...base,
      entries: [
        leg(avail('fees:trade', 'USDT', 'house'), 'credit', '1'),
        leg({ ownerType: 'user', ownerId: U, assetId: 'USDT', kind: 'hold', purpose: 'order:1' }, 'debit', '1'),
      ],
    },
  ],
  [
    'hold with no purpose',
    {
      ...base,
      entries: [
        leg(avail(U), 'credit', '1'),
        leg({ ownerType: 'user', ownerId: U, assetId: 'USDT', kind: 'hold', purpose: '  ' }, 'debit', '1'),
      ],
    },
  ],
  [
    'legacy purpose',
    {
      ...base,
      entries: [
        leg(avail(U), 'credit', '1'),
        leg({ ownerType: 'user', ownerId: U, assetId: 'USDT', kind: 'escrow', purpose: 'legacy:x' }, 'debit', '1'),
      ],
    },
  ],
  [
    'purposed available',
    { ...base, entries: [leg(avail(U), 'credit', '1'), leg({ ...avail('fees:trade', 'USDT', 'house'), purpose: 'x' }, 'debit', '1')] },
  ],
  ['unicode owner', { ...base, entries: [leg(avail(U), 'credit', '1'), leg(avail('fees:tradé', 'USDT', 'house'), 'debit', '1')] }],
  [
    'treasury places',
    {
      ...base,
      entries: [
        leg(avail('treasury-wallet:hot', 'USDT', 'treasury'), 'credit', '1'),
        leg(avail('charge-receivable:bank.x', 'USDT', 'treasury'), 'credit', '1'),
        leg(avail('partner-fee-receivable:p', 'USDT', 'treasury'), 'credit', '1'),
        leg(avail('rail:card', 'USDT', 'treasury'), 'debit', '3'),
      ],
    },
  ],
  [
    'merchant money',
    {
      ...base,
      entries: [
        leg(avail('pay:clearing:m1', 'USDT', 'module'), 'credit', '1'),
        leg(avail('pay:proceeds:m1', 'USDT', 'module'), 'debit', '1'),
      ],
    },
  ],
];
for (const [label, post] of HANDMADE) cases.push(caseOf(`handmade: ${label}`, post));

// `replayMetaDiffers`: posted meta against a retry's.
const META = [
  ['ledger', 'withdraw.held', { fee: '1', rail: 'r' }, { fee: '1', rail: 'r' }],
  ['ledger', 'withdraw.held', { fee: '1', rail: 'r' }, { rail: 'r' }],
  ['ledger', 'withdraw.settled', {}, { fee: '' }],
  ['ledger', 'withdraw.reversed', { rail: 1 }, { rail: '1' }],
  ['ledger', 'withdraw.reversed', { rail: null }, {}],
  ['ledger', 'withdraw.reversed', { rail: true }, { rail: 'true' }],
  ['ledger', 'withdraw.reversed', { rail: { a: 1 } }, { rail: '[object Object]' }],
  ['ledger', 'withdraw.reversed', { rail: [1, 2] }, { rail: '1,2' }],
  ['ledger', 'deposit.credited', { fee: '1' }, { fee: '2' }],
  ['pay', 'withdraw.held', { fee: '1' }, { fee: '2' }],
];
const meta = META.map(([module, reason, posted, asked]) => ({
  module,
  reason,
  posted,
  asked,
  differs: lc.replayMetaDiffers(posted, { module, reason, meta: asked }),
}));

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = '// @generated by crates/svc-ledger/scripts/record-posting.mjs from packages/ledger-client/src/gate. Do not edit by hand.\n';
const rs = (s) => JSON.stringify(s);
const list = (xs) => `&[${xs.map(rs).join(', ')}]`;
const recordedRs = `${HEADER}//! The posting door's tables, as the gate holds them: the recipe gate's catalog (\`recipe-gate.ts\`), the
//! post allowlist (\`caller-allowlist.ts\`), the recipes only a proven key may post (\`caller-binding.ts\`), and the account
//! prefixes whose balance is held as a negative (\`accounts.ts\`).

/// One repeat rule: a fixed prefix of legs, then a tail of at least \`min_tail\` legs, each one of \`tokens\`.
pub struct Repeat {
    pub prefix: &'static [&'static str],
    pub tokens: &'static [&'static str],
    pub min_tail: usize,
}

/// One catalog row, keyed \`module::reason\`.
pub struct Row {
    pub key: &'static str,
    pub name: &'static str,
    pub min_legs: usize,
    /// Each sampled body's legs, joined by \`;\`.
    pub signatures: &'static [&'static str],
    pub repeats: &'static [Repeat],
}

/// \`RECIPE_CATALOG\`, in the gate's order.
pub const CATALOG: [Row; ${catalog.length}] = [
${catalog
  .map(
    (r) =>
      `    Row { key: ${rs(r.key)}, name: ${rs(r.name)}, min_legs: ${r.minLegs}, signatures: ${list(r.signatures)}, repeats: &[${r.repeats
        .map((p) => `Repeat { prefix: ${list(p.prefix)}, tokens: ${list(p.tokens)}, min_tail: ${p.minTail} }`)
        .join(', ')}] },`,
  )
  .join('\n')}
];

/// \`LEDGER_POST_ALLOWLIST\`: \`(service, [(recipe, module)])\`, in the gate's order.
pub const ALLOWLIST: [(&str, &[(&str, &str)]); ${allowlist.length}] = [
${allowlist.map(([s, grants]) => `    (${rs(s)}, &[${grants.map(([r, m]) => `(${rs(r)}, ${rs(m)})`).join(', ')}]),`).join('\n')}
];

/// \`KEY_REQUIRED_RECIPES\`.
pub const KEY_REQUIRED: [&str; ${keyRequired.length}] = [${keyRequired.map(rs).join(', ')}];

/// A treasury account under one of these holds its balance as a negative (\`OWN_FUNDS_PLACE_PREFIXES\`,
/// \`CHARGE_RECEIVABLE_PREFIX\`, \`PARTNER_FEE_RECEIVABLE_PREFIX\`).
pub const HELD_NEGATIVE: [&str; ${heldNegative.length}] = [${heldNegative.map(rs).join(', ')}];
`;

const FIXTURES = `${CRATE}tests/fixtures/posting-parity/`;
// One part stays well under the CI review's 400,000-byte part.
const PART_BYTES = 300_000;
const parts = [];
for (const line of cases.map((c) => `${JSON.stringify(c)}\n`)) {
  if (parts.length === 0 || parts.at(-1).length + line.length > PART_BYTES) parts.push('');
  parts[parts.length - 1] += line;
}
const doorCallers = Object.entries(LEDGER_DOOR_CALLERS);
const callersRs = `${HEADER}//! Which services may call each service door (\`LEDGER_DOOR_CALLERS\`, \`packages/ledger-client/src/gate/door-callers.ts\`).
//! A door with no caller refuses every key.

/// \`(door, callers)\`, in the gate's order.
pub const DOOR_CALLERS: [(&str, &[&str]); ${doorCallers.length}] = [
${doorCallers.map(([door, callers]) => `    (${rs(door)}, &[${callers.map(rs).join(', ')}]),`).join('\n')}
];
`;
const outputs = [
  [`${CRATE}src/posting/recorded.rs`, recordedRs],
  [`${CRATE}src/door/callers.rs`, callersRs],
  [`${FIXTURES}meta.json`, JSON.stringify({ services: SERVICES, meta })],
  ...parts.map((text, i) => [`${FIXTURES}cases-${String(i).padStart(2, '0')}.jsonl`, text]),
];
// A part the recording no longer makes is stale too.
const written = new Set(outputs.map(([file]) => file));
const leftover = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .map((f) => `${FIXTURES}${f}`)
      .filter((f) => !written.has(f))
  : [];

const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (file, text) => {
  if (file.endsWith('.rs')) return execFileSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], { input: text, encoding: 'utf8' });
  if (file.endsWith('.json'))
    return execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
  return text;
};

let stale = 0;
if (CHECK) {
  for (const file of leftover) {
    console.error(`stale: ${file.slice(ROOT.length)} (no longer recorded)`);
    stale++;
  }
} else {
  mkdirSync(FIXTURES, { recursive: true });
  for (const file of leftover) rmSync(file);
}
for (const [file, raw] of outputs) {
  const text = formatted(file, raw);
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(file, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${file.slice(ROOT.length)}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
console.log(
  `${catalog.length} catalog rows, ${allowlist.length} callers, ${cases.length} posting cases in ${parts.length} parts, ${meta.length} meta cases`,
);
if (stale) process.exit(1);
