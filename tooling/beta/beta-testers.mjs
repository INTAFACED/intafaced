#!/usr/bin/env node
/**
 * Where each beta tester is, from the beta's own records: one section, one block per invited tester, by account id.
 *
 *   node tooling/beta/beta-host.mjs testers [--json]      on the beta stack (beta-host.mjs runs this with its stack's env)
 *   node tooling/beta/beta-testers.mjs [--root <dir>] [--logs <dir>] [--json]
 *
 * What it reads, all on this machine, nothing sent anywhere and nothing written:
 *   - identity's accounts (local-test-gates.mjs listAccountsAndTiers): who signed up and when. Only accounts an invited
 *     token owns (beta-invited.mjs invitedOwner) are shown; an email is used only for that and is never printed.
 *   - granted.json and testnet-funded.json (beta-invited.mjs, beta-testnet.mjs): when the TEST partner grant and the TEST
 *     USDC on the venue's test network reached the account.
 *   - the edge's `edge.account_call` lines in the stack's edge.log (svc-edge account-call-log.ts): every reply to a
 *     signed-in call by account id, with the venue's refusal words. Without those lines (an edge older than them) the
 *     section says so, and shows only what the files above hold.
 *
 * The stages, each the first time it happened:
 *   signed up       the account exists
 *   wallet made     a successful embeddedWallet.create, or a testnet send recorded for the account's wallet
 *   funded          the TEST grant at the partner, or TEST USDC sent on the venue's test network
 *   desk reached    a call only the trading desk makes (DESK_PATHS)
 *   first order     a successful venue submit after the desk's order preview (a submit alone may be an approval)
 * Venue refusals are refused venue writes (not reads, which the app polls) with their words; errors are replies of 500
 * or more, and refused writes elsewhere, with their code. A tester is STUCK when an error or refusal came after their
 * last stage, or when they have not placed a first order and made no new stage for STUCK_AFTER_MS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invitedOwner, invitedPaths, readInvited } from './beta-invited.mjs';
import { readTestnet } from './beta-testnet.mjs';

const SELF = fileURLToPath(import.meta.url);
/** The edge's line for one signed-in call (services/svc-edge/src/account-call-log.ts ACCOUNT_CALL_MSG). */
export const ACCOUNT_CALL_MSG = 'edge.account_call';
/** No new stage for this long, short of a first order, is stuck. */
export const STUCK_AFTER_MS = 30 * 60_000;
export const STAGES = Object.freeze(['signedUp', 'wallet', 'funded', 'desk', 'firstOrder']);
const STAGE_WORDS = { signedUp: 'signed up', wallet: 'wallet made', funded: 'funded', desk: 'desk reached', firstOrder: 'first order' };
/** Calls the trading desk makes and nothing else does. */
export const DESK_PATHS = Object.freeze([
  '/api/v1/venue/session',
  '/api/v1/venue/session/start',
  '/api/v1/venue/leverage',
  '/api/v1/venue/builder-fee-approval',
  '/api/v1/venue/preview',
  '/api/v1/venue/prepare',
  '/api/v1/venue/orders/open',
]);
const WALLET_CREATE = '/api/protocol/trpc/embeddedWallet.create';
const VENUE = /^\/api\/v1\/venue(\/|$)/;
/** How many refusals and errors a tester's block lists, newest last. */
const LIST_MAX = 5;

const ok = (status) => status >= 200 && status < 300;
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const earliest = (...ms) => {
  const known = ms.filter((m) => Number.isFinite(m));
  return known.length ? Math.min(...known) : null;
};

/** One edge line as a call, or null when it is not an account call line. */
export function parseCallLine(text) {
  if (!text.includes(`"${ACCOUNT_CALL_MSG}"`)) return null;
  let l;
  try {
    l = JSON.parse(text);
  } catch {
    return null;
  }
  if (l?.msg !== ACCOUNT_CALL_MSG || typeof l.accountId !== 'string' || !Number.isFinite(l.time)) return null;
  return {
    at: l.time,
    accountId: l.accountId,
    method: String(l.method ?? ''),
    path: String(l.path ?? ''),
    status: Number(l.status),
    code: typeof l.code === 'string' ? l.code : null,
    refusal: typeof l.refusal === 'string' ? l.refusal : null,
  };
}

/** Every account call line in an edge log, grouped by account id: Map accountId -> calls in log order. */
export async function readCalls(file, accountIds) {
  const calls = new Map();
  if (!fs.existsSync(file)) return { calls, lines: 0 };
  let lines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const text of rl) {
    const c = parseCallLine(text);
    if (!c) continue;
    lines += 1;
    if (accountIds && !accountIds.has(c.accountId)) continue;
    if (!calls.has(c.accountId)) calls.set(c.accountId, []);
    calls.get(c.accountId).push(c);
  }
  return { calls, lines };
}

/** Groups equal refusals or errors, keeping the newest LIST_MAX by their last time. */
function grouped(rows, keyOf) {
  const by = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const g = by.get(k) ?? { ...r, count: 0, first: r.at };
    g.count += 1;
    g.at = r.at;
    by.set(k, g);
  }
  return [...by.values()].sort((a, b) => a.at - b.at).slice(-LIST_MAX);
}

/** One tester's block, from what was read. Pure: `now` in ms. */
export function testerRow({ user, granted, testnet, calls = [], now }) {
  const sends = testnet.filter((r) => r.userId === user.id);
  const sent = sends.filter((r) => r.state === 'sent').map((r) => Date.parse(r.at));
  const firstCall = (pred) => calls.find(pred)?.at ?? null;
  const firstPreview = firstCall((c) => c.method === 'POST' && c.path === '/api/v1/venue/preview' && ok(c.status));
  const at = {
    signedUp: earliest(Date.parse(user.createdAt), calls[0]?.at),
    wallet: earliest(
      firstCall((c) => c.path === WALLET_CREATE && ok(c.status)),
      ...sends.map((r) => Date.parse(r.at)),
    ),
    funded: earliest(Date.parse(granted?.partnerAt ?? granted?.at), ...sent),
    desk: firstCall((c) => DESK_PATHS.includes(c.path)),
    firstOrder:
      firstPreview === null
        ? null
        : firstCall((c) => c.method === 'POST' && c.path === '/api/v1/venue/submit' && ok(c.status) && c.at >= firstPreview),
  };
  const refusals = grouped(
    calls.filter((c) => c.method !== 'GET' && VENUE.test(c.path) && c.status >= 400 && c.status < 500),
    (c) => `${c.path} ${c.code} ${c.refusal}`,
  ).map((g) => ({ at: iso(g.at), count: g.count, path: g.path, status: g.status, code: g.code, text: g.refusal }));
  const errorRows = calls.filter((c) => c.status >= 500 || (c.method !== 'GET' && !VENUE.test(c.path) && c.status >= 400));
  const errors = grouped(errorRows, (c) => `${c.method} ${c.path} ${c.status} ${c.code}`).map((g) => ({
    at: iso(g.at),
    count: g.count,
    call: `${g.method} ${g.path}`,
    status: g.status,
    code: g.code,
  }));
  const stageTimes = STAGES.map((s) => at[s]).filter((m) => m !== null);
  const progressAt = stageTimes.length ? Math.max(...stageTimes) : null;
  const lastCall = calls.at(-1) ?? null;
  const lastAction = calls.filter((c) => c.method !== 'GET').at(-1) ?? null;
  const troubleAfter = [...calls]
    .reverse()
    .find((c) => c.at > (progressAt ?? 0) && (c.status >= 500 || (c.method !== 'GET' && c.status >= 400)));
  const idle = at.firstOrder === null && progressAt !== null && now - progressAt >= STUCK_AFTER_MS;
  const stuck = troubleAfter
    ? `${troubleAfter.method} ${troubleAfter.path} answered ${troubleAfter.status}${troubleAfter.code ? ` ${troubleAfter.code}` : ''} after their last stage`
    : idle
      ? `no new stage for ${Math.floor((now - progressAt) / 60_000)} min, short of a first order`
      : null;
  return {
    accountId: user.id,
    stages: Object.fromEntries(STAGES.map((s) => [s, iso(at[s])])),
    testnetSend: sends.at(-1)?.state ?? null,
    refusals,
    errors,
    lastSeen: lastCall ? { at: iso(lastCall.at), call: `${lastCall.method} ${lastCall.path}`, status: lastCall.status } : null,
    lastAction: lastAction ? { at: iso(lastAction.at), call: `${lastAction.method} ${lastAction.path}`, status: lastAction.status } : null,
    stuck,
  };
}

/** The view: the invited accounts only, newest sign-up first. */
export function testerView({ users, tokens, granted, testnet, calls, now }) {
  return users
    .filter((u) => invitedOwner(u.email, tokens))
    .map((user) => testerRow({ user, granted: granted[user.id], testnet, calls: calls.get(user.id) ?? [], now }))
    .sort((a, b) => String(b.stages.signedUp).localeCompare(String(a.stages.signedUp)));
}

/** The section as text: one block per tester. */
export function viewText(rows, { callLines, logFile }) {
  const out = [`Beta testers: ${rows.length} invited account(s), ${rows.filter((r) => r.stuck).length} STUCK`];
  if (callLines === 0)
    out.push(
      `  (no ${ACCOUNT_CALL_MSG} lines in ${logFile}: the edge does not log them yet, so desk, orders, refusals and errors are blank)`,
    );
  for (const r of rows) {
    out.push('', `${r.stuck ? 'STUCK ' : ''}account ${r.accountId}`);
    if (r.stuck) out.push(`  why: ${r.stuck}`);
    for (const s of STAGES)
      out.push(
        `  ${STAGE_WORDS[s].padEnd(13)} ${r.stages[s] ?? '-'}${s === 'funded' && r.testnetSend ? ` (testnet send: ${r.testnetSend})` : ''}`,
      );
    for (const f of r.refusals)
      out.push(`  venue refused ${f.path} ${f.status}${f.code ? ` ${f.code}` : ''} x${f.count}, last ${f.at}: "${f.text ?? '(no words)'}"`);
    for (const e of r.errors) out.push(`  error ${e.call} ${e.status}${e.code ? ` ${e.code}` : ''} x${e.count}, last ${e.at}`);
    out.push(`  last action  ${r.lastAction ? `${r.lastAction.at} ${r.lastAction.call} ${r.lastAction.status}` : '-'}`);
    out.push(`  last seen    ${r.lastSeen ? `${r.lastSeen.at} ${r.lastSeen.call} ${r.lastSeen.status}` : '-'}`);
  }
  return out.join('\n');
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback;
}

export async function main(argv) {
  const root = arg(argv, '--root', path.join(os.homedir(), '.intafaced', 'beta'));
  const gates = await import(pathToFileURL(path.join(path.dirname(SELF), '..', 'scripts', 'local-test-gates.mjs')).href);
  const secrets = readJson(gates.gatePaths().secrets, null);
  if (!secrets) throw new Error(`the stack has no secrets.json (${gates.gatePaths().secrets}): is it running?`);
  const logFile = path.join(arg(argv, '--logs', path.join(gates.gatePaths().stateDir, 'logs')), 'edge.log');
  const files = invitedPaths(root);
  const tokens = readInvited(files.invited);
  const { users } = gates.listAccountsAndTiers(secrets);
  const invitedIds = new Set(users.filter((u) => invitedOwner(u.email, tokens)).map((u) => u.id));
  const { calls, lines } = await readCalls(logFile, invitedIds);
  const rows = testerView({
    users,
    tokens,
    granted: readJson(files.granted, {}),
    testnet: Object.values(readTestnet(files.testnet).accounts),
    calls,
    now: Date.now(),
  });
  console.log(
    argv.includes('--json')
      ? JSON.stringify({ at: new Date().toISOString(), callLines: lines, testers: rows }, null, 2)
      : viewText(rows, { callLines: lines, logFile }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`beta-testers: ${err.message}`);
    process.exit(1);
  });
}
