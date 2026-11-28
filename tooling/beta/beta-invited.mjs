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
 *       `local-test-stack.mjs fund` (the real ledger, what the stack's own exchange trades from), at most
 *       MAX_FUNDED_PER_PERSON accounts per person (the agents' own invite, agentsInvite, past it). The same GRANT is kept in that person's TEST partner account
 *       (`testPartner.set({ custody: 'off' })`, `testPartner.fund`), where the launch model holds a person's money and
 *       which Home and Money read (#10632): on every pass, once per account and fund id, so a restart of svc-bank (which
 *       empties the TEST partner) puts it back. It is made as that person on their own live session; an account not
 *       signed in waits for the next pass. On a stack whose svc-ledger runs custody off, as the beta's does and launch will
 *       (#11019), the ledger holds no tester's money: the grant posts nothing there (`local:fund` to a person refuses then)
 *       and is kept only at the TEST partner. An invited account holding full that has made its own embedded wallet gets
 *       TEST USDC on Hyperliquid's TEST network in that wallet, once (beta-testnet.mjs, #10842). Prints one line per
 *       action and nothing when there is nothing to do. `--root` holds invited.json, granted.json and
 *       testnet-funded.json (default ~/.intafaced/beta); `--checkout` is the stack's checkout whose tools it runs (default: this file's own).
 *
 * TEST funds only: it runs only the stack's own TEST tools, which refuse anything but this machine's TEST stack, and
 * the grant is fixed: one GRANT per account, its ledger reference fixed per account so a repeat posts nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveDeps, readTestnet, testnetAddress, testnetCandidates, testnetStep } from './beta-testnet.mjs';

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

/**
 * The agents' own invite (#11104): the token every walk, plant and ready check signs up under, which starts with
 * `zenyoda` (project-state tooling/beta/kit.mjs agentsToken). Each walk makes a new account, so the per-person cap spent
 * its three places on 24-25 Nov and every later walk's verified account got nothing (27 Nov: Home and Money showed no
 * balance). Its accounts are not counted against that cap for the grant, which a custody-off stack keeps only at the
 * TEST partner, as the testnet step already exempts the ready check's accounts (beta-testnet.mjs judgeAccount, Nino's
 * guide on project-state#4046, 25 Nov). Every other invited person stays capped.
 */
export const agentsInvite = (token) => String(token ?? '').startsWith('zenyoda');

/** The ledger reference of an account's one grant: fixed, so a second post of it is a no-op. */
export const grantRef = (userId) => `beta-invite-${userId}`;
/** The TEST partner's fund id of an account's grant: the partner pays it in once per person and fund id. */
export const PARTNER_FUND_ID = 'beta-invite:v1';

/**
 * The granted accounts whose GRANT is kept at the TEST partner on this pass: an account granted to a token still
 * recorded, with a live session (`sessions` Map userId -> sessionId). Returns [{ userId, sessionId, first }], `first`
 * when the partner has never been funded for it (so the pass prints a line only then).
 */
export function planPartner({ granted, tokens, sessions }) {
  return Object.entries(granted)
    .filter(([userId, g]) => tokens.has(g.token) && sessions.has(userId))
    .map(([userId, g]) => ({ userId, sessionId: sessions.get(userId), first: !g.partnerAt }));
}

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
    if (n >= MAX_FUNDED_PER_PERSON && !agentsInvite(u.token)) continue;
    perPerson.set(u.token, n + 1);
    fund.push({ userId: u.id, email: u.email, token: u.token });
  }
  return { approve, fund };
}

export const invitedPaths = (root = path.join(os.homedir(), '.intafaced', 'beta')) => ({
  invited: path.join(root, 'invited.json'),
  granted: path.join(root, 'granted.json'),
  /** The testnet sends to invited testers' embedded wallets (beta-testnet.mjs). */
  testnet: path.join(root, 'testnet-funded.json'),
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

/**
 * How recent a view must be for its viewer to count as testing now (#11046): a viewer seen once days ago holds nothing.
 */
export const INVITED_RECENT_MS = 24 * 3_600_000;
/** A repeat view rewrites the viewer's time at most this often: the mailbox page reloads every 10 seconds. */
const SEEN_EVERY_MS = 10 * 60_000;

/**
 * The recorded tokens, as a Set; with `seenSince` (ms), only viewers last seen at or after it. Without it, everyone ever
 * invited: the invited pass approves and funds each of them whenever they come back.
 */
export function readInvited(file, { seenSince } = {}) {
  const tokens = Object.entries(readJson(file, {})?.tokens ?? {});
  if (seenSince === undefined) return new Set(tokens.map(([t]) => t));
  return new Set(tokens.filter(([, at]) => Date.parse(at) >= seenSince).map(([t]) => t));
}

/**
 * Record a token the mailbox saw on an Access-verified request, with the time of its last view; true when it is new. A
 * malformed token is never kept.
 */
export function recordInvited(file, token, now = new Date()) {
  if (!TOKEN_RE.test(String(token ?? ''))) return false;
  const doc = readJson(file, null) ?? { kind: 'intafaced-beta-invited', label: 'TEST beta: tokens of invited viewers', tokens: {} };
  const seen = doc.tokens?.[token];
  if (seen && !(now.getTime() - Date.parse(seen) >= SEEN_EVERY_MS)) return false;
  doc.tokens = { ...doc.tokens, [token]: now.toISOString() };
  writePrivate(file, doc);
  return !seen;
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
  // Custody off (the beta's stack, launch's money model): the ledger holds no customer money, so the grant is the partner's.
  const { stackCustodyOff } = await import(pathToFileURL(path.join(checkout, 'tooling', 'scripts', 'local-test-state.mjs')).href);
  const ledgerGrant = !stackCustodyOff();
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
    if (!ledgerGrant) {
      const granted = readJson(files.granted, {});
      granted[f.userId] = { token: f.token, asset: GRANT.asset, amount: GRANT.amount, at: new Date().toISOString(), ledger: false };
      writePrivate(files.granted, granted);
      console.log(
        `invited ${f.email}: ${GRANT.amount} TEST ${GRANT.asset} granted at the TEST partner only (custody off: nothing in the ledger)`,
      );
      continue;
    }
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
  await keepAtPartner({ gates, secrets, tokens, files });
  await sendOnTestnet({ gates, secrets, tokens, files, checkout });
}

/**
 * TEST USDC on the testnet to an invited, Full account's own wallet, once (beta-testnet.mjs): its embedded wallet, read
 * through svc-protocol's `protocol.embeddedWallet.status` record, else its own browser wallet connected on /wallet/venue
 * (`protocol.venueWallet.status`, testnetAddress), each read as that person on their live session.
 */
async function sendOnTestnet({ gates, secrets, tokens, files, checkout }) {
  const { users, approved } = gates.listAccountsAndTiers(secrets);
  const candidates = testnetCandidates({ users, approved, tokens, accounts: readTestnet(files.testnet).accounts });
  const inFlight = Object.values(readTestnet(files.testnet).accounts).some((r) => r.state !== 'sent');
  if (candidates.length === 0 && !inFlight) return;
  const { PROTOCOL_EMBEDDED_WALLET_STATUS, PROTOCOL_VENUE_WALLET_STATUS } = await import(
    pathToFileURL(path.join(checkout, 'packages', 'contracts', 'dist', 'protocol-wallet-procedures.js')).href
  );
  const sessions = gates.liveSessions(
    secrets,
    candidates.map((c) => c.userId),
  );
  let ctx = null;
  const walletOf = async (userId) => {
    const sessionId = sessions.get(userId);
    if (!sessionId) return null; // not signed in: the next pass reads it
    ctx ??= await gates.makeContext({ log: () => {} });
    const token = await gates.personToken(ctx, { userId, sessionId }, 60, gates.PERSON_PROTOCOL_READ_SCOPES);
    const embedded = (await ctx.edge.record(PROTOCOL_EMBEDDED_WALLET_STATUS, undefined, token)).data?.wallet?.address ?? null;
    if (embedded) return embedded;
    // No embedded wallet: the tester's own browser wallet, once they connected it on /wallet/venue (#11067).
    const connections = (await ctx.edge.record(PROTOCOL_VENUE_WALLET_STATUS, undefined, token)).data?.connections;
    return testnetAddress({ embedded, connections });
  };
  try {
    await testnetStep({ file: files.testnet, candidates, deps: { ...liveDeps(), walletOf }, log: (l) => console.log(l) });
  } catch (err) {
    console.log(`invited: testnet TEST USDC step stopped: ${err.message}`);
  }
}

/** Keeps each granted account's GRANT in its own TEST partner account (planPartner), made as that person. */
async function keepAtPartner({ gates, secrets, tokens, files }) {
  const granted = readJson(files.granted, {});
  const plan = planPartner({ granted, tokens, sessions: gates.liveSessions(secrets, Object.keys(granted)) });
  if (plan.length === 0) return;
  const ctx = await gates.makeContext({ log: () => {} });
  const refused = (res) => (res.json?.result?.data === undefined ? `${res.status} ${gates.refusalText(res)}` : null);
  for (const p of plan) {
    const token = await gates.personToken(ctx, p);
    const set = await ctx.edge.mutate('bank', 'testPartner.set', { custody: 'off' }, token);
    const fund = refused(set)
      ? set
      : await ctx.edge.mutate('bank', 'testPartner.fund', { fundId: PARTNER_FUND_ID, assetId: GRANT.asset, amount: GRANT.amount }, token);
    const why = refused(fund);
    if (why) {
      console.log(`invited ${p.userId}: TEST funds NOT kept at the TEST partner: ${why}`);
      continue;
    }
    if (!p.first) continue;
    const now = readJson(files.granted, {});
    now[p.userId] = { ...now[p.userId], partnerAt: new Date().toISOString() };
    writePrivate(files.granted, now);
    console.log(`invited ${p.userId}: ${GRANT.amount} TEST ${GRANT.asset} kept in their TEST partner account (fund ${PARTNER_FUND_ID})`);
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
