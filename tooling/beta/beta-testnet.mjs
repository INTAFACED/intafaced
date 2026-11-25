/**
 * TEST USDC on Hyperliquid's TEST network for the beta's invited testers, once, with nobody in the loop (#10842; the
 * invited pass, beta-invited.mjs, calls `testnetStep` on every pass; docs/runbooks/beta-link.md).
 *
 * An invited account (beta-invited.mjs invitedOwner) that holds Full and has made its own embedded wallet (svc-protocol's
 * `protocol.embeddedWallet.status` record, read as that person) gets TESTNET_GRANT sent to that wallet's address by the
 * dispatch-only workflow `hl-testnet-send.yml` on main, the only place the platform's funded testnet key is used
 * (project-state decision PR #3883); the box only dispatches it with `gh` and never holds that key. At most
 * MAX_FUNDED_PER_PERSON accounts per person, as the ledger grant.
 *
 * Each send is kept in `testnet-funded.json` beside granted.json under its business key (testnetKey: account and
 * address), written as `dispatching` BEFORE the dispatch. So a crash anywhere after that line leaves a record, never a
 * silent second send:
 *   - `dispatched` (the run id gh printed): the run is read until it completes; success is `sent`; any other end is
 *     `failed`, unless the address already holds the grant on the testnet, which is `sent`.
 *   - `dispatching` with no run id (a crash between the record and gh's answer, or a gh that printed none): `sent` as
 *     soon as the address holds the grant; otherwise it waits UNKNOWN_AFTER_MS, longer than any run of the workflow
 *     (its 15-minute timeout and the queue), before it counts as `failed`. It errs toward late, never toward twice: the
 *     funder is one shared TEST account (about 11 testers' worth), and a tester kept waiting is a line in round.log.
 *   - `failed` is retried after RETRY_AFTER_MS, at most MAX_TRIES sends per key, and only while the address does not
 *     already hold the grant.
 * One send is in flight at a time: the workflow's concurrency group keeps one run and one pending, and cancels an older
 * pending one, so a second dispatch while one waits could cancel a tester's run.
 *
 * Before every send the funder's free TEST USDC is read on the testnet (its address is the one the workflow's own log
 * names, `USDC <funder> -> <to>`); under the grant, nothing is sent and round.log names it once.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_FUNDED_PER_PERSON, invitedOwner } from './beta-invited.mjs';

/** What one tester's embedded wallet gets on the testnet, once: margin for a few small BTC-PERP orders at 20x. */
export const TESTNET_GRANT = Object.freeze({ asset: 'USDC', amount: '25' });
export const SEND_REPO = 'INTAFACED/intafaced';
export const SEND_WORKFLOW = 'hl-testnet-send.yml';
/** Hyperliquid's TEST network's public read door: balances only, no key. */
export const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info';
/** Sends per key, the first included: a dispatch or run that fails is tried again up to this. */
export const MAX_TRIES = 3;
/** How long a failed send waits before it is tried again. */
export const RETRY_AFTER_MS = 5 * 60_000;
/** How long a send whose run id is unknown waits before it counts as failed: longer than any run of the workflow. */
export const UNKNOWN_AFTER_MS = 20 * 60_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The business key of one account's one testnet send. */
export const testnetKey = (userId, address) => `beta-testnet:${userId}:${String(address).toLowerCase()}`;

const SCALE = 8;
/** A non-negative decimal string as a scaled bigint (8 places); never a number (AGENTS.md floor 2). */
export function units(text) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`not a TEST USDC amount: "${text}"`);
  return BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? '').slice(0, SCALE).padEnd(SCALE, '0'));
}
const holdsGrant = (amount) => units(amount) >= units(TESTNET_GRANT.amount);

/**
 * The accounts that may get a testnet send now: owned by a recorded token, holding Full (or institutional), with no
 * send record of their own, and under the per-person cap counting every record that person's accounts already have.
 * `users` [{ id, email }], `approved` Map userId -> Set of tiers, `tokens` Set, `accounts` the file's records.
 */
export function testnetCandidates({ users, approved, tokens, accounts }) {
  const perPerson = new Map();
  const has = new Set();
  for (const r of Object.values(accounts)) {
    perPerson.set(r.token, (perPerson.get(r.token) ?? 0) + 1);
    has.add(r.userId);
  }
  const out = [];
  for (const u of users) {
    const token = invitedOwner(u.email, tokens);
    if (!token || has.has(u.id)) continue;
    const tiers = approved.get(u.id) ?? new Set();
    if (!(tiers.has('full') || tiers.has('institutional'))) continue;
    const n = perPerson.get(token) ?? 0;
    if (n >= MAX_FUNDED_PER_PERSON) continue;
    perPerson.set(token, n + 1);
    out.push({ userId: u.id, email: u.email, token });
  }
  return out;
}

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
export const readTestnet = (file) => {
  const doc = readJson(file, null);
  return doc?.accounts
    ? doc
    : { kind: 'intafaced-beta-testnet', label: 'TEST beta: TEST USDC sent on the testnet to invited testers', accounts: {} };
};

/**
 * One pass's testnet work: settle the send in flight, or start the next one. `deps`: `walletOf(userId)` the account's
 * embedded wallet address or null, `usdcAt(address)` its TEST USDC on the testnet (decimal string), `funderAddress(runId?)`
 * the funder named by that run's log (or the newest successful run's), `spotFree(address)` the funder's free TEST USDC,
 * `dispatch(to, amount)` -> { ok, runId?, why }, `runOf(runId)` -> { status, conclusion } or null. `now()` ms.
 */
export async function testnetStep({ file, candidates, deps, log, now = () => Date.now() }) {
  const doc = readTestnet(file);
  const save = () => writePrivate(file, doc);
  const at = () => new Date(now()).toISOString();
  const age = (r) => now() - Date.parse(r.at);
  const held = async (address) => holdsGrant(await deps.usdcAt(address));
  const sent = (r, why) => {
    Object.assign(r, { state: 'sent', at: at() });
    log(`invited ${r.userId}: ${r.amount} TEST USDC on the testnet at ${r.address} (${why})`);
  };
  const failed = (r, why) => {
    Object.assign(r, { state: 'failed', at: at(), why });
    const last = r.tries >= MAX_TRIES;
    log(
      `invited ${r.userId}: testnet TEST USDC NOT sent to ${r.address}: ${why}${last ? `; not tried again (${r.tries} of ${MAX_TRIES} tries)` : `; tried again in ${RETRY_AFTER_MS / 60_000} min`}`,
    );
  };

  // 1. The send in flight, if any.
  for (const r of Object.values(doc.accounts)) {
    if (r.state === 'dispatched') {
      const run = await deps.runOf(r.runId);
      if (run?.status !== 'completed') continue;
      if (run.conclusion === 'success') {
        doc.funder = (await deps.funderAddress(r.runId).catch(() => null)) ?? doc.funder;
        sent(r, `run ${r.runId}`);
      } else if (await held(r.address)) sent(r, `run ${r.runId} ended ${run.conclusion}, but the address holds it`);
      else failed(r, `run ${r.runId} ended ${run.conclusion}`);
    } else if (r.state === 'dispatching') {
      if (await held(r.address)) sent(r, 'its dispatch left no run id; the address holds it');
      else if (age(r) >= UNKNOWN_AFTER_MS)
        failed(r, `no run id was kept for its dispatch and the address holds nothing after ${UNKNOWN_AFTER_MS / 60_000} min`);
    }
  }
  save();
  if (Object.values(doc.accounts).some((r) => r.state === 'dispatching' || r.state === 'dispatched')) return;

  // 2. The next send: a failed one due again first, then a new account with a wallet.
  let next = Object.values(doc.accounts).find((r) => r.state === 'failed' && r.tries < MAX_TRIES && age(r) >= RETRY_AFTER_MS);
  if (!next) {
    for (const c of candidates) {
      const address = await deps.walletOf(c.userId);
      if (!address) continue;
      if (!ADDRESS_RE.test(address)) {
        log(`invited ${c.userId}: testnet TEST USDC NOT sent: the wallet record's address "${address}" is not an 0x address`);
        continue;
      }
      next = { userId: c.userId, token: c.token, address: address.toLowerCase(), amount: TESTNET_GRANT.amount, tries: 0 };
      break;
    }
  }
  if (!next) return;

  // 3. The funder must hold the grant; said once per reading, not on every pass.
  doc.funder ??= await deps.funderAddress().catch(() => null);
  const free = doc.funder ? await deps.spotFree(doc.funder) : null;
  if (free === null || units(free) < units(next.amount)) {
    const why =
      free === null
        ? 'the funder is unknown (no successful hl-testnet-send run names it)'
        : `the funder ${doc.funder} holds ${free} free TEST USDC`;
    if (doc.funderLow !== why) {
      doc.funderLow = why;
      save();
      log(`invited ${next.userId}: testnet TEST USDC NOT sent to ${next.address}: ${why}, under ${next.amount}`);
    }
    return;
  }
  delete doc.funderLow;

  // 4. Recorded before the dispatch; an address that already holds the grant is never sent more.
  const key = testnetKey(next.userId, next.address);
  const r = (doc.accounts[key] = { ...next, ...doc.accounts[key] });
  if (await held(r.address)) {
    sent(r, 'it already held it; nothing sent');
    save();
    return;
  }
  Object.assign(r, { state: 'dispatching', at: at(), tries: (r.tries ?? 0) + 1, runId: undefined, why: undefined });
  save();
  const d = await deps.dispatch(r.address, r.amount);
  if (d.ok && d.runId) {
    Object.assign(r, { state: 'dispatched', runId: d.runId });
    log(
      `invited ${r.userId}: ${r.amount} TEST USDC on its way to ${r.address} on the testnet (${SEND_WORKFLOW} run ${d.runId}, try ${r.tries})`,
    );
  } else if (d.ok)
    log(`invited ${r.userId}: ${SEND_WORKFLOW} dispatched for ${r.address}, but gh named no run; it is settled from the address`);
  else failed(r, `the dispatch failed: ${d.why}`);
  save();
}

const gh = (args, timeout = 60_000) => spawnSync('gh', args, { encoding: 'utf8', timeout });
const lastLine = (r) =>
  String(r.stderr || r.stdout || r.error?.message || '')
    .trim()
    .split('\n')
    .at(-1);

async function info(body, fetchImpl) {
  const res = await fetchImpl(TESTNET_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`testnet info ${body.type}: HTTP ${res.status}`);
  return res.json();
}
const fmt = (u) => `${u / 10n ** BigInt(SCALE)}.${String(u % 10n ** BigInt(SCALE)).padStart(SCALE, '0')}`.replace(/\.?0+$/, '');

/** The real deps but `walletOf`: gh as the box is signed in, and the testnet's public read door. */
export function liveDeps({ fetchImpl = fetch } = {}) {
  return {
    async usdcAt(address) {
      const perp = await info({ type: 'clearinghouseState', user: address }, fetchImpl);
      const spot = await info({ type: 'spotClearinghouseState', user: address }, fetchImpl);
      const spotUsdc = spot?.balances?.find((b) => b.coin === 'USDC')?.total ?? '0';
      return fmt(units(perp?.marginSummary?.accountValue ?? '0') + units(spotUsdc));
    },
    async spotFree(address) {
      const spot = await info({ type: 'spotClearinghouseState', user: address }, fetchImpl);
      const row = spot?.balances?.find((b) => b.coin === 'USDC');
      if (!row) return '0';
      const free = units(row.total) - units(row.hold ?? '0');
      return fmt(free < 0n ? 0n : free);
    },
    async funderAddress(runId) {
      let id = runId;
      if (!id) {
        const r = gh([
          'run',
          'list',
          '-R',
          SEND_REPO,
          '--workflow',
          SEND_WORKFLOW,
          '--status',
          'success',
          '-L',
          '1',
          '--json',
          'databaseId',
        ]);
        id = r.status === 0 ? JSON.parse(r.stdout)[0]?.databaseId : null;
        if (!id) return null;
      }
      const r = gh(['run', 'view', String(id), '-R', SEND_REPO, '--log'], 90_000);
      return /\bUSDC (0x[0-9a-f]{40}) -> 0x[0-9a-f]{40}/i.exec(r.stdout ?? '')?.[1]?.toLowerCase() ?? null;
    },
    async dispatch(to, amount) {
      const r = gh(['workflow', 'run', SEND_WORKFLOW, '-R', SEND_REPO, '--ref', 'main', '-f', `to=${to}`, '-f', `amount=${amount}`]);
      if (r.status !== 0) return { ok: false, why: `gh exit ${r.status}: ${lastLine(r)}` };
      return { ok: true, runId: /\/actions\/runs\/(\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null };
    },
    async runOf(runId) {
      const r = gh(['run', 'view', String(runId), '-R', SEND_REPO, '--json', 'status,conclusion']);
      return r.status === 0 ? JSON.parse(r.stdout) : null;
    },
  };
}
