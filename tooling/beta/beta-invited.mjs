#!/usr/bin/env node
/**
 * The beta's invited testers, approved and funded with no agent step (#10243; docs/runbooks/beta-link.md).
 *
 * Who counts as invited: a person Cloudflare Access let through, which is only an email on the beta's invite list. The
 * public front puts that person's token (beta-front.mjs viewerToken) on every TEST mailbox request it passes on, and
 * the mailbox (beta-host.mjs) records each token it sees in `invited.json`. Every invited person opens the mailbox to
 * read their sign-up code, so every one is recorded before they can confirm an account. An account is an invited
 * person's when its email is a recorded token, or the token, a dot and more, at `local-test.invalid`: exactly the
 * addresses the mailbox shows that person. Any other account, uninvited or made on the box itself, gets nothing here.
 *
 *   node tooling/beta/beta-invited.mjs pass [--root <dir>] [--checkout <dir>]
 *       one pass on the stack named by LOCAL_STACK_SLOT and LOCAL_STACK_STATE (beta-host.mjs stackEnv): an invited
 *       account's pending basic or full request is approved by the stack's two TEST operators (local-test-gates.mjs,
 *       the same two-person door `verify` uses), and an invited account holding full gets GRANT once, through
 *       `local-test-stack.mjs fund` (the real ledger), at most MAX_FUNDED_PER_PERSON accounts per person. Prints one
 *       line per action and nothing when there is nothing to do. `--root` holds invited.json and granted.json (default
 *       ~/.intafaced/beta); `--checkout` is the stack's checkout whose tools it runs (default: this file's own).
 *
 * TEST funds only: it runs only the stack's own TEST tools, which refuse anything but this machine's TEST stack, and
 * the grant is fixed: one GRANT per account, its ledger reference fixed per account so a repeat posts nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/** The TEST funds an invited person's verified account gets, once. */
export const GRANT = Object.freeze({ asset: 'USDT', amount: '1000' });
/** How many of one person's accounts are funded: the TEST funds one invite can reach are capped at 3 × GRANT. */
export const MAX_FUNDED_PER_PERSON = 3;
/** The only domain an invited person's TEST addresses use (the mailbox's own example address). */
const INVITED_DOMAIN = 'local-test.invalid';
/** A viewer token's shape (beta-front.mjs viewerToken): lowercase letters, digits and dashes, then 10 hex characters. */
export const TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{10}$/;

/** The recorded token that owns `email`, or null: its local part is the token, or the token, a dot and more. */
export function invitedOwner(email, tokens) {
  const e = String(email ?? '').toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1 || e.slice(at + 1) !== INVITED_DOMAIN) return null;
  const local = e.slice(0, at);
  const token = local.split('.')[0];
  return tokens.has(token) && (local === token || local.length > token.length + 1) ? token : null;
}

/** The ledger reference of an account's one grant: fixed, so a second post of it is a no-op. */
export const grantRef = (userId) => `beta-invite-${userId}`;

/**
 * What one pass does, from what it read. `users` [{ id, email }], `approved` Map userId -> Set of tiers, `pending`
 * [{ userId, tier }], `tokens` Set, `granted` { userId: { token } }. Returns `{ approve: [userId], fund: [{ userId,
 * email, token }] }`; an account no recorded token owns is in neither.
 */
export function planPass({ users, approved, pending, tokens, granted }) {
  const owned = users.map((u) => ({ ...u, token: invitedOwner(u.email, tokens) })).filter((u) => u.token);
  const waiting = new Set(pending.filter((r) => r.tier === 'full' || r.tier === 'basic').map((r) => r.userId));
  const approve = owned.filter((u) => waiting.has(u.id)).map((u) => u.id);
  const perPerson = new Map();
  for (const g of Object.values(granted)) perPerson.set(g.token, (perPerson.get(g.token) ?? 0) + 1);
  const fund = [];
  for (const u of owned) {
    const tiers = approved.get(u.id) ?? new Set();
    if (granted[u.id] || !(tiers.has('full') || tiers.has('institutional'))) continue;
    const n = perPerson.get(u.token) ?? 0;
    if (n >= MAX_FUNDED_PER_PERSON) continue;
    perPerson.set(u.token, n + 1);
    fund.push({ userId: u.id, email: u.email, token: u.token });
  }
  return { approve, fund };
}

export const invitedPaths = (root = path.join(os.homedir(), '.intafaced', 'beta')) => ({
  invited: path.join(root, 'invited.json'),
  granted: path.join(root, 'granted.json'),
});

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writePrivate = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

/** The recorded tokens, as a Set. */
export const readInvited = (file) => new Set(Object.keys(readJson(file, {})?.tokens ?? {}));

/** Record a token the mailbox saw on an Access-verified request; true when it is new. A malformed token is never kept. */
export function recordInvited(file, token, now = new Date()) {
  if (!TOKEN_RE.test(String(token ?? ''))) return false;
  const doc = readJson(file, null) ?? { kind: 'intafaced-beta-invited', label: 'TEST beta: tokens of invited viewers', tokens: {} };
  if (doc.tokens?.[token]) return false;
  doc.tokens = { ...(doc.tokens ?? {}), [token]: now.toISOString() };
  writePrivate(file, doc);
  return true;
}

async function pass({ root, checkout }) {
  const files = invitedPaths(root);
  const tokens = readInvited(files.invited);
  if (tokens.size === 0) return;
  const gates = await import(pathToFileURL(path.join(checkout, 'tooling', 'scripts', 'local-test-gates.mjs')).href);
  const secrets = readJson(gates.gatePaths().secrets, null);
  if (!secrets) throw new Error('the stack has no secrets.json: is it running?');
  const read = () => {
    const { users, approved, pending } = gates.listAccountsAndTiers(secrets);
    return planPass({ users, approved, pending, tokens, granted: readJson(files.granted, {}) });
  };
  let plan = read();
  if (plan.approve.length) {
    const ctx = await gates.makeContext({ log: (l) => console.log(l) });
    const rows = await gates.approvePending(ctx, null, { userIds: plan.approve });
    for (const r of rows)
      console.log(
        `invited ${r.handle}: ${r.tier} ${r.ok ? "approved through the stack's two-person TEST door" : `NOT approved: ${r.why}`}`,
      );
    plan = read();
  }
  for (const f of plan.fund) {
    const r = spawnSync(
      process.execPath,
      [
        path.join(checkout, 'tooling', 'scripts', 'local-test-stack.mjs'),
        'fund',
        f.email,
        GRANT.asset,
        GRANT.amount,
        '--ref',
        grantRef(f.userId),
      ],
      { cwd: checkout, encoding: 'utf8', timeout: 60_000 },
    );
    if (r.status !== 0) {
      console.log(
        `invited ${f.email}: TEST funds NOT added (exit ${r.status}): ${String(r.stderr || r.stdout)
          .trim()
          .split('\n')
          .at(-1)}`,
      );
      continue;
    }
    const granted = readJson(files.granted, {});
    granted[f.userId] = { token: f.token, asset: GRANT.asset, amount: GRANT.amount, at: new Date().toISOString() };
    writePrivate(files.granted, granted);
    console.log(`invited ${f.email}: ${GRANT.amount} TEST ${GRANT.asset} added through the ledger (ref ${grantRef(f.userId)})`);
  }
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'pass') {
    console.error('usage: beta-invited.mjs pass [--root <dir>] [--checkout <dir>]');
    process.exit(2);
  }
  pass({
    root: arg(argv, '--root', path.join(os.homedir(), '.intafaced', 'beta')),
    checkout: arg(argv, '--checkout', path.resolve(path.dirname(SELF), '..', '..')),
  }).catch((err) => {
    console.error(`beta-invited: ${err.message}`);
    process.exit(1);
  });
}
