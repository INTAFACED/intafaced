/**
 * Journey-style test of #10243 on a running TEST stack: an invited address signs up, requests Full and places a TEST
 * order within a minute with no operator step; an uninvited address gets nothing.
 *
 *   node tooling/beta/beta-host.mjs invited-test [--checkout <dir>] [--root <dir>] [--watch]
 *
 * Run it with the stack's environment (LOCAL_STACK_SLOT, LOCAL_STACK_STATE), under the user's systemd manager as
 * docs/runbooks/beta-link.md says, so the stack's tools can read its processes. `--checkout` is the stack's checkout,
 * whose tools it calls (default: this one). `--root` holds invited.json and granted.json (default: a new temporary
 * folder). The invited person stands in for one Cloudflare Access let through: the front passes their token to the
 * mailbox. `--watch` runs `beta-host.mjs serve`'s own TEST mailbox (on a free port, fetched with that token as the
 * front sends it) and its invited loop on `--root`, reading the beta's status.json; without it, a running `serve` on
 * `--root` must do both, and the test writes the record the mailbox would.
 *
 * It creates two TEST accounts on the stack and places one resting TEST order far under the market; it moves no other
 * money. Prints the timeline as one JSON line; exits 1 on any failed check.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { viewerToken } from './beta-front.mjs';
import { betaPaths, invitedLoop, serveMailbox } from './beta-host.mjs';
import { GRANT, invitedPaths, readInvited, recordInvited } from './beta-invited.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback;
};
const checkout = opt('--checkout', path.resolve(HERE, '..', '..'));
const root = opt('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'beta-invited-journey-')));
const watch = argv.includes('--watch');
const tool = (rel) => import(pathToFileURL(path.join(checkout, rel)).href);
const gates = await tool('tooling/scripts/local-test-gates.mjs');
const { planRestingBuy } = await tool('tooling/scripts/local-test-world.mjs');
const { localEmailOutboxPath } = await tool('tooling/scripts/local-test-state.mjs');
const { LOCAL_TEST_DEVICE_KEY } = await tool('tooling/scripts/local-test-device.mjs');

const t0 = Date.now();
const timeline = [];
const failures = [];
const mark = (what) => timeline.push({ s: Math.round((Date.now() - t0) / 100) / 10, what });
const check = (ok, what) => {
  mark(`${ok ? 'ok' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const ctx = await gates.makeContext({ log: () => {} });
const data = (res) => res.json?.result?.data;

/** A person: an Access email (made up, never mailed), the token the mailbox gives it, and their TEST address. */
function person(tag) {
  const id = crypto.randomBytes(4).toString('hex');
  const access = `beta-${tag}-${id}@example.com`;
  const token = viewerToken(access);
  return {
    access,
    token,
    handle: `beta${tag}${id}`,
    email: `${token}.1@local-test.invalid`,
    password: crypto.randomBytes(18).toString('base64url'),
  };
}

const outbox = () => {
  try {
    return fs.readFileSync(localEmailOutboxPath(), 'utf8');
  } catch {
    return '';
  }
};
async function codeFor(email, purpose) {
  for (let i = 0; i < 40; i++) {
    const line = outbox()
      .split('\n')
      .filter((l) => l.includes(`purpose=${purpose}`) && l.includes(`email=${email}`))
      .at(-1);
    const code = line && /\bcode=(\d+)/.exec(line)?.[1];
    if (code) return code;
    await sleep(250);
  }
  throw new Error(`no ${purpose} code for ${email} in the TEST outbox`);
}

/** Sign up as the page does (auth.signUpStart, the mailed code, auth.signUpConfirm), then request Full. */
async function signUpAndRequestFull(p) {
  const start = await ctx.edge.mutate('identity', 'auth.signUpStart', {
    channel: 'email',
    handle: p.handle,
    email: p.email,
    password: p.password,
    country: 'DE',
    usPerson: false,
    dateOfBirth: '1990-05-01',
    accountType: 'individual',
  });
  if (!data(start)?.flowId) throw new Error(`signUpStart refused: ${gates.refusalText(start)}`);
  const code = await codeFor(p.email, 'signup-code');
  const done = await ctx.edge.mutate('identity', 'auth.signUpConfirm', { flowId: data(start).flowId, code });
  if (!data(done)?.accessToken) throw new Error(`signUpConfirm refused: ${gates.refusalText(done)}`);
  p.userId = data(done).userId;
  p.token = data(done).accessToken;
  const kyc = await ctx.edge.mutate('identity', 'kyc.submit', { tier: 'full', jurisdiction: 'ZZ' }, data(done).accessToken);
  if (!data(kyc)?.id) throw new Error(`kyc.submit refused: ${gates.refusalText(kyc)}`);
}

async function login(p) {
  const res = await ctx.edge.mutate('identity', 'auth.login', {
    identifier: p.email,
    password: p.password,
    deviceKey: LOCAL_TEST_DEVICE_KEY,
  });
  // Signed in again, as the app asks after a verification; a refusal (a new device's code step) keeps the sign-up's session.
  return data(res)?.accessToken ?? p.token;
}

const tierOf = (p) => {
  const { approved, pending } = gates.listAccountsAndTiers(ctx.secrets);
  return { full: approved.get(p.userId)?.has('full') ?? false, pending: pending.some((r) => r.userId === p.userId) };
};

/** One resting TEST buy, 10% under the last price, for about 25 USDT: it rests and never fills. */
async function placeOrder(p) {
  const token = await login(p);
  const markets = await ctx.edge.call('GET', '/api/v1/markets?limit=500', undefined, token);
  const m = (markets.json ?? []).find((x) => x.symbol === 'BTC/USDT' && x.orderable);
  if (!m) throw new Error(`BTC/USDT is not orderable on this stack (${markets.status})`);
  const t = await ctx.edge.call('GET', `/api/v1/ticker/${encodeURIComponent('BTC/USDT')}`, undefined, token);
  if (!t.json?.last) throw new Error('no last BTC/USDT price to anchor a TEST order');
  const { price, amount } = planRestingBuy({
    last: t.json.last,
    bpsBelow: 1000,
    notionalTarget: '25',
    pricePrecision: m.precision.price,
    amountPrecision: m.precision.amount,
    minAmount: m.limits.amount.min ?? m.precision.amount,
    minCost: m.limits.cost.min ?? '0',
  });
  const body = {
    symbol: 'BTC/USDT',
    type: 'limit',
    side: 'buy',
    amount,
    price,
    timeInForce: 'GTC',
    clientOrderId: `beta-invite-${p.handle}`,
  };
  const res = await ctx.edge.call('POST', '/api/v1/orders', body, token);
  return {
    ok: res.status >= 200 && res.status < 300 && Boolean(res.json?.id),
    status: res.status,
    why: res.json?.intafacedCode ?? res.json?.message ?? res.text?.slice(0, 160),
    order: res.json?.id,
  };
}

// Standing in for `beta-host.mjs serve` on `--root`: its TEST mailbox (on a free port) and its invited loop, the same
// code, reading the stack's status.json and writing its lines to <root>/round.log.
const paths = {
  ...betaPaths(),
  state: process.env.LOCAL_STACK_STATE ?? betaPaths().state,
  root,
  ...invitedPaths(root),
  log: path.join(root, 'round.log'),
  checkout,
};
let mailbox = null;
let stopLoop = null;
if (watch) {
  mailbox = serveMailbox(paths, 0);
  await new Promise((r) => mailbox.once('listening', r));
  stopLoop = invitedLoop(paths, { script: path.join(HERE, 'beta-invited.mjs') }); // this branch's pass, before it is on main
}
const passLines = () => {
  try {
    return fs.readFileSync(paths.log, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const invited = person('inv');
const uninvited = person('out');
try {
  // The invited person came through Access: they open the mailbox to read their code, and the front passes it their
  // token (beta-front.mjs VIEWER_HEADER). With --watch that is the mailbox's own code; without, the record it writes.
  if (mailbox) {
    const res = await fetch(`http://127.0.0.1:${mailbox.address().port}/`, { headers: { 'x-beta-viewer': invited.token } });
    check(res.status === 200 && readInvited(paths.invited).has(invited.token), 'the mailbox recorded the invited viewer it served');
  } else recordInvited(paths.invited, invited.token);
  mark(`invited viewer recorded (${invited.token}); uninvited viewer never was (${uninvited.token})`);
  await signUpAndRequestFull(invited);
  const requested = Date.now();
  mark(`invited ${invited.email} signed up and requested Full`);
  await signUpAndRequestFull(uninvited);
  const uninvitedAt = Date.now();
  mark(`uninvited ${uninvited.email} signed up and requested Full`);

  let order = null;
  for (;;) {
    const s = tierOf(invited);
    if (s.full) {
      order = await placeOrder(invited);
      if (order.ok) break;
    }
    if (Date.now() - requested > 60_000) break;
    await sleep(2_000);
  }
  const took = Math.round((Date.now() - requested) / 100) / 10;
  check(tierOf(invited).full, `invited: Full approved by the stack's TEST approvers, no operator step`);
  check(
    Boolean(order?.ok),
    `invited: a TEST order placed ${took} s after the Full request (order ${order?.order ?? `refused: ${order?.status} ${order?.why}`})`,
  );
  check(took <= 60, `invited: within a minute (${took} s)`);
  const granted = JSON.parse(fs.readFileSync(paths.granted, 'utf8'));
  check(granted[invited.userId]?.amount === GRANT.amount, `invited: ${GRANT.amount} TEST ${GRANT.asset} granted once`);
  // Home and Money read the person's TEST partner account (#10632): the grant is held there, as their own bank reads it.
  let held = null;
  const own = await login(invited);
  for (let i = 0; i < 20 && !held; i++) {
    const spaces = data(await ctx.edge.query('bank', 'spaces.list', { limit: 200 }, own)) ?? [];
    held =
      spaces.find(
        (s) => s.kind === 'primary' && s.assetId === GRANT.asset && s.heldAt && /^(\d+)(?:\.0*)?$/.exec(s.balance)?.[1] === GRANT.amount,
      ) ?? null;
    if (!held) await sleep(2_000);
  }
  check(
    Boolean(held),
    `invited: ${GRANT.amount} TEST ${GRANT.asset} held at ${held?.heldAt?.label ?? 'no partner'}, which Home and Money read`,
  );

  // The uninvited person waits a whole minute of passes and gets nothing: still pending, no grant, the order refused.
  while (Date.now() - uninvitedAt < 65_000) await sleep(1_000);
  mark(`uninvited: waited ${Math.round((Date.now() - uninvitedAt) / 1000)} s after its Full request`);
  const u = tierOf(uninvited);
  check(!u.full && u.pending, 'uninvited: Full still waits, nobody approved it');
  check(!granted[uninvited.userId], 'uninvited: no TEST funds');
  const refused = await placeOrder(uninvited).catch((e) => ({ ok: false, why: e.message }));
  check(!refused.ok, `uninvited: the same TEST order is refused (${refused.status ?? ''} ${refused.why ?? ''})`.trim());
} catch (err) {
  check(false, `stopped: ${err.message}`);
} finally {
  stopLoop?.();
  mailbox?.close();
}
console.log(
  JSON.stringify(
    { ok: failures.length === 0, passLog: passLines(), invited: invited.email, uninvited: uninvited.email, timeline },
    null,
    1,
  ),
);
process.exit(failures.length === 0 ? 0 : 1);
