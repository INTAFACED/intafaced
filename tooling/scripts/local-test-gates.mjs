#!/usr/bin/env node
/**
 * LOCAL TEST GATES — option B (Nitro, 2026-10-13). Local test stack only.
 *
 *   node tooling/scripts/local-test-gates.mjs apply      do everything below, in order (idempotent)
 *   node tooling/scripts/local-test-gates.mjs operators  create / sign in the two labelled test operators
 *   node tooling/scripts/local-test-gates.mjs lifecycle  publish the market lifecycle (the "owner" stand-in)
 *   node tooling/scripts/local-test-gates.mjs open       open the books in matching (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs verify     test accounts submit, test operators approve "full"
 *   node tooling/scripts/local-test-gates.mjs terms      publish TEST personal transfer limits (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs assets     publish TEST supported assets and networks (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs futures    list the TEST perpetual, publish TEST derivatives terms and quiz
 *   node tooling/scripts/local-test-gates.mjs halt <SYMBOL>    halt one book in matching (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs resume <SYMBOL>  resume a halted book (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs limits     publish the TEST price band and open-order cap (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs charts     publish the TEST charts owner values (counts; data class two-person approval)
 *   node tooling/scripts/local-test-gates.mjs chart-class <SYMBOL> <dataClass>   one market's data class (two-person approval)
 *   node tooling/scripts/local-test-gates.mjs risk <SYMBOL> collar=0.1|unset throttle=20|unset   change one market's limits
 *   node tooling/scripts/local-test-gates.mjs status     read-only: what is open, who is verified
 *
 * What this stands in for, and nothing else:
 *   1. the owner who publishes a market lifecycle (opens markets),
 *   2. the compliance officer who accepts the local test sanctions list (the stack env, not this file),
 *   3. the operator who verifies test accounts,
 *   4. the two people who publish personal transfer limits (Pay sends refuse while none are published).
 *   5. the two founders who publish which assets and networks are supported (the address book refuses while none are),
 *   6. the operator who halts and resumes one market (a journey step: new orders refused, cancels still work).
 *   7. the owner who lists the TEST perpetual and publishes the derivatives risk agreement, margin terms and quiz
 *      (every futures order refuses while none are published).
 * Every record it writes is labelled "LOCAL TEST — not a real approval" and carries one of the markers
 * below, so a production check can recognise and refuse them (see MARKERS).
 *
 * No service code is bypassed. Each step uses the door the real operator would use:
 *   - lifecycle: svc-trade's signed internal route /internal/market-lifecycle
 *     (services/svc-trade/src/market-lifecycle-routes.ts), HMAC with the stack's INTERNAL_SERVICE_SECRET.
 *   - open: svc-matching POST /markets/:id/open consumes an identity action approval proposed by
 *     operator A and approved by a different signed-in operator B who passed a TOTP second factor
 *     (services/svc-identity/src/action-approval-router.ts). Only svc-trade may call that route, so the
 *     stack signs as svc-trade with its own internal secret (services/svc-matching/src/router.ts, TRADE_ONLY).
 *   - verify: identity kyc.submit by the account itself, then kyc.approve by operator A, which needs
 *     scope admin:compliance, a TOTP session and a consumed approval from operator B
 *     (services/svc-identity/src/router.ts, kyc.approve). User sessions never carry admin:compliance, so the
 *     operator token is minted the way the repo documents for operator principals (.env.example,
 *     ADMIN_OPERATOR_TOKEN: issueAccessToken with the signing secret, for a real signed-in session).
 *     Nothing writes a table directly.
 *
 * Containment (failure it prevents: a stand-in approval reaching a real environment): every command
 * refuses unless ~/.intafaced/local-test-stack/LOCAL-TEST-STACK.json exists and every target is
 * http://127.0.0.1:<a port that marker lists>. No target is configurable to anything else.
 *
 * Docs: docs/LOCAL-TEST-STACK.md
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localStackState, assertActiveLocalStack, localPgBin } from './local-test-state.mjs';
import { GuardError, assertLocalTarget as assertMarketTarget } from './local-test-market.mjs';
import { FOUNDER_STEPS_NAME, FOUNDER_VAULT_NAME, enrolledFounderPair } from './local-test-founders.mjs';
import { TEST_AGREEMENTS, TEST_ELIGIBILITY_RULES } from './local-test-futures-terms.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..', '..');
const HOST = '127.0.0.1';
const PSQL = path.join(localPgBin(), 'psql');
const DB_NAME = 'intafaced_local_test';

export { GuardError };

/** Every marker the stand-ins carry. A production-side check can refuse anything that matches one of these. */
export const MARKERS = Object.freeze({
  idPrefix: 'local-test:',
  label: 'LOCAL TEST — not a real approval',
  lifecycleLabel: 'LOCAL TEST — not an owner or legal approval',
  policyVersion: 'local-test:v1',
  operatorHandlePrefix: 'local_test_operator_',
  operatorEmailDomain: '@local-test.invalid',
  kycJurisdiction: 'ZZ', // names no real country; same convention as the stack's sanctions fixture
  screeningEnv: 'INTAFACED_SCREENING_FAIL_CLOSED=off',
  approvalTtlEnv: 'IDENTITY_ACTION_APPROVAL_TTL_SECONDS',
});
const P = MARKERS.idPrefix;

/** Lifecycle publications last this long on the local stack; `lifecycle` renews them when under a week is left. */
const LIFECYCLE_DAYS = 30;
const RENEW_BELOW_DAYS = 7;
/** Only the 24/7 crypto spot books: the other schedules are market-hours books that are closed at times. */
export const OPENABLE_SCHEDULE = 'crypto-24x7';

// ── Containment guard (exported for tests) ──────────────────────────────────

const PORT_NAMES = ['edge', 'ledger', 'identity', 'trade', 'matching'];

/** Throws GuardError unless the local test stack marker exists and every URL is its own 127.0.0.1 port. */
export function assertLocalTarget({ home = os.homedir(), urls } = {}) {
  const probe = assertMarketTarget({ home, urls: [] });
  const ports = probe.marker.ports ?? {};
  const missing = PORT_NAMES.filter((n) => !ports[n]);
  if (missing.length) throw new GuardError(`refusing: the marker does not list ports for ${missing.join(', ')}`);
  const own = urls ?? PORT_NAMES.map((n) => `http://${HOST}:${ports[n]}`);
  return assertMarketTarget({ home, urls: own });
}

export function gatePaths(home = os.homedir()) {
  const stateDir = localStackState(home);
  return {
    stateDir,
    marker: path.join(stateDir, 'LOCAL-TEST-STACK.json'),
    secrets: path.join(stateDir, 'secrets.json'),
    operators: path.join(stateDir, 'operators.json'),
    marketAccounts: path.join(stateDir, 'market-accounts.json'),
    worldAccounts: path.join(stateDir, 'world-accounts.json'),
  };
}

// ── Pure builders (exported for tests) ──────────────────────────────────────

const FAMILIES = [
  'legalEntityAndJurisdiction',
  'counterpartyRole',
  'deterministicSettlement',
  'custodyAndTransferSupport',
  'oracleIndexAndDisruption',
  'liquidityAndMarketQuality',
  'surveillanceAndRetention',
  'riskAndLimits',
  'operationsAndIncidentOwner',
  'windDownAndResiduals',
];

/** The signed body svc-trade's /internal/market-lifecycle accepts. Every id starts with `local-test:`. */
export function buildLifecyclePublication({ marketId, now = new Date(), causalPredecessorId = null, days = LIFECYCLE_DAYS }) {
  if (typeof marketId !== 'string' || !marketId.trim()) throw new Error('marketId required');
  const at = now.toISOString();
  const expires = new Date(now.getTime() + days * 86_400_000).toISOString();
  const stand = `${P}owner-stand-in`;
  const dossier = {
    dossierId: `${P}dossier:${marketId}`,
    marketId,
    ruleVersion: `${P}rules`,
    instrumentVersion: `${P}instrument:${marketId}`,
    ...Object.fromEntries(FAMILIES.map((f) => [f, { status: 'READY', evidenceRefs: [`${P}${f}: ${MARKERS.lifecycleLabel}`] }])),
    approvedAt: at,
    approvalRefs: [`${P}approval: ${MARKERS.lifecycleLabel}`],
  };
  return {
    marketId,
    idempotencyKey: `${P}publish:${at}`,
    causalPredecessorId,
    authoritySubject: stand,
    authorityScope: `market:${marketId}:${P}publish-lifecycle`,
    ruleVersion: dossier.ruleVersion,
    instrumentVersion: dossier.instrumentVersion,
    observedAt: at,
    effectiveAt: at,
    expiresAt: expires,
    authority: {
      decision: 'AUTHORIZED',
      reasonCode: null,
      legalOwnerId: stand,
      accountId: `${P}account`,
      subAccountId: `${P}sub-account`,
      actorId: stand,
      origin: 'OPERATOR',
      sessionId: `${P}session`,
      credentialId: null,
      grantId: `${P}grant:${marketId}`,
      grantVersion: `${P}1`,
      mandateId: null,
      decidedAt: at,
      freshnessAt: at,
    },
    dossier,
  };
}

/** True when a stored publication is ours and still has at least `renewBelowDays` left. */
export function lifecycleIsFresh(publication, now = new Date(), renewBelowDays = RENEW_BELOW_DAYS) {
  if (!publication || publication.authoritySubject !== `${P}owner-stand-in`) return false;
  if (publication.authority?.decision !== 'AUTHORIZED') return false;
  return Date.parse(publication.expiresAt) - now.getTime() > renewBelowDays * 86_400_000;
}

/** Same hash services/svc-matching/src/action-approval-consume.ts computes for a matching action. */
export function matchingPayloadHash(actionType, fields) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;
}
/** Same hash services/svc-identity/src/auth/privileged-dual-control.ts computes. */
export function identityPayloadHash(targetId, fields = {}) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify({ targetId, ...fields }))
    .digest('hex')}`;
}

/** A four-eyes proposal for one book in matching: `open`, `halt` or `resume` (services/svc-matching/src/router.ts). */
export function bookProposal(action, marketId) {
  if (!['open', 'halt', 'resume'].includes(action)) throw new Error(`no book action ${action}`);
  return {
    actionType: `matching.${action}`,
    targetService: 'svc-matching',
    targetId: `${action}:${marketId}`,
    expectedVersion: '1',
    payloadHash: matchingPayloadHash(`matching.${action}`, { marketId }),
    policyVersion: MARKERS.policyVersion,
  };
}

export const openProposal = (marketId) => bookProposal('open', marketId);

export function kycApproveProposal(recordId) {
  return {
    actionType: 'kyc.approve',
    targetService: 'svc-identity',
    targetId: 'kyc.approve',
    expectedVersion: '1',
    payloadHash: identityPayloadHash('kyc.approve', { recordId }),
    policyVersion: MARKERS.policyVersion,
  };
}

/** Operator identities: labelled, local, never real. */
export function operatorIdentity(letter) {
  const l = String(letter).toLowerCase();
  if (!/^[ab]$/.test(l)) throw new Error('operators are a and b');
  return { handle: `${MARKERS.operatorHandlePrefix}${l}`, email: `local-test-operator-${l}${MARKERS.operatorEmailDomain}` };
}

/** Which markets get a stand-in publication: orderable, active spot books on the 24/7 crypto schedule, and the
 * labelled TEST perpetual (`test: true`, listed only by `local-test-gates.mjs futures`) for the derivatives journeys. */
export function openableMarkets(markets) {
  return markets.filter(
    (m) => m.active && m.orderable && (m.spot || (m.swap && m.test === true)) && !m.paper && m.schedule === OPENABLE_SCHEDULE,
  );
}

/** Accounts that still need a `full` record: `have` maps userId -> Set of approved tiers. */
export function needsFullTier(users, approved) {
  return users.filter((u) => !(approved.get(u.id) ?? new Set()).has('full') && !(approved.get(u.id) ?? new Set()).has('institutional'));
}

// ── Plumbing ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const say = (line = '') => process.stdout.write(`${line}\n`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

async function libs() {
  try {
    const [contracts, tokens, totp] = await Promise.all([
      load('packages/contracts/dist/index.js'),
      load('packages/auth/dist/tokens.js'),
      load('services/svc-identity/dist/auth/totp.js'),
    ]);
    return { contracts, tokens, totp };
  } catch (err) {
    throw new Error(`packages are not built (${err.message}). Run: pnpm local:stack --rebuild`);
  }
}

function psqlRead(secrets, role, sql) {
  const r = spawnSync(
    PSQL,
    ['-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-h', HOST, '-p', '15460', '-U', role, '-d', DB_NAME, '-c', sql],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', PGPASSWORD: secrets.pgService },
    },
  );
  if (r.error) throw new Error(`psql could not start (${PSQL}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

/** Read-only: the accounts on this local database and the tiers each already holds. */
export function listAccountsAndTiers(secrets) {
  const users = psqlRead(
    secrets,
    'svc_identity',
    'SELECT id::text, handle::text, email::text FROM identity.users ORDER BY created_at, id',
  ).map(([id, handle, email]) => ({ id, handle, email }));
  const approved = new Map();
  for (const [uid, tier] of psqlRead(
    secrets,
    'svc_identity',
    `SELECT user_id::text, tier::text FROM identity.kyc_records WHERE status = 'approved' AND (expires_at IS NULL OR expires_at > now())`,
  )) {
    if (!approved.has(uid)) approved.set(uid, new Set());
    approved.get(uid).add(tier);
  }
  const pending = psqlRead(
    secrets,
    'svc_identity',
    `SELECT id::text, user_id::text, tier::text FROM identity.kyc_records WHERE status = 'pending' ORDER BY created_at`,
  ).map(([id, userId, tier]) => ({ id, userId, tier }));
  return { users, approved, pending };
}

export function pendingKycCount(secrets) {
  return Number(psqlRead(secrets, 'svc_identity', `SELECT count(*) FROM identity.kyc_records WHERE status = 'pending'`)[0][0]);
}

// ── Edge client (operators and accounts go through the customer front door) ──

class Edge {
  constructor(base, origin) {
    this.base = base;
    this.origin = origin;
  }
  async call(method, route, body, token) {
    if (method !== 'GET') assertActiveLocalStack();
    const headers = { origin: this.origin, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${this.base}${route}`, {
      redirect: 'error',
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON refusal */
    }
    return { status: res.status, json, text };
  }
  mutate(mod, proc, input, token) {
    return this.call('POST', `/api/${mod}/trpc/${proc}`, input ?? {}, token);
  }
  query(mod, proc, input, token) {
    return this.call(
      'GET',
      `/api/${mod}/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
      undefined,
      token,
    );
  }
}

/** The exact refusal a service gave, as received. */
export function refusalText(res) {
  const e = res.json?.error;
  if (e) return `${e.message ?? e.json?.message ?? ''} [${e.data?.code ?? e.json?.data?.code ?? res.status}]`.trim();
  return String(res.text ?? '').slice(0, 300);
}
const data = (res) => res.json?.result?.data;

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// ── Context ─────────────────────────────────────────────────────────────────

export async function makeContext({ home = os.homedir(), log = say } = {}) {
  const { paths, marker } = assertLocalTarget({ home });
  assertActiveLocalStack({ stateDir: paths.stateDir });
  const p = gatePaths(home);
  const secrets = readJson(p.secrets, null);
  if (!secrets?.internal || !secrets?.jwt) throw new Error('secrets.json is missing the internal or jwt secret');
  const { contracts, tokens, totp } = await libs();
  const url = (name) => `http://${HOST}:${marker.ports[name]}`;
  return {
    log,
    paths: p,
    secrets,
    marker,
    contracts,
    tokens,
    totp,
    url,
    edge: new Edge(url('edge'), `http://${HOST}:${marker.ports.customer ?? 3210}`),
    guard: paths,
  };
}

// ── Operators ───────────────────────────────────────────────────────────────

function loadOperators(ctx) {
  const file = readJson(ctx.paths.operators, {});
  const out = {};
  for (const l of ['a', 'b']) {
    const id = operatorIdentity(l);
    const have = file.operators?.[l];
    out[l] = have?.password
      ? have
      : { ...id, password: crypto.randomBytes(18).toString('base64url'), userId: null, totpSecret: null, lastStep: 0 };
  }
  return out;
}
function saveOperators(ctx, ops) {
  writePrivate(ctx.paths.operators, {
    kind: 'intafaced-local-test-operators',
    label: MARKERS.label,
    note: 'Two labelled LOCAL TEST operator accounts. Not people. Never valid anywhere but this stack.',
    operators: ops,
  });
}

const stepNow = () => Math.floor(Date.now() / 30_000);

/** A TOTP code for a step strictly after the last one this operator used (identity refuses replays). */
async function freshCode(ctx, op) {
  while (stepNow() <= Number(op.lastStep ?? 0)) await sleep(1000);
  const code = ctx.totp.totp(op.totpSecret);
  op.lastStep = stepNow();
  return code;
}

async function operatorLogin(ctx, op) {
  const input = { identifier: op.email ?? op.handle, password: op.password };
  if (op.totpSecret) input.totpCode = await freshCode(ctx, op);
  const res = await ctx.edge.mutate('identity', 'auth.login', input);
  const d = data(res);
  if (!d?.accessToken) throw new Error(`operator ${op.handle} login refused (${res.status}): ${refusalText(res)}`);
  op.userId = d.userId;
  op.sessionId = decodeJwtPayload(d.accessToken).sid;
  return d.accessToken;
}

/** Register (once) and enrol a second factor for both operators. Returns the operators with live sessions. */
export async function ensureOperators(ctx) {
  const ops = loadOperators(ctx);
  saveOperators(ctx, ops); // credentials on disk before the first register, so a crash cannot lose them
  for (const l of ['a', 'b']) {
    const op = ops[l];
    let token = null;
    if (!op.totpSecret) {
      const reg = await ctx.edge.mutate('identity', 'auth.register', { handle: op.handle, email: op.email, password: op.password });
      if (data(reg)?.accessToken) {
        token = data(reg).accessToken;
        ctx.log(`operator ${op.handle} registered (${MARKERS.label})`);
      } else {
        const login = await ctx.edge.mutate('identity', 'auth.login', { identifier: op.email, password: op.password });
        token = data(login)?.accessToken ?? null;
        if (!token)
          throw new Error(`operator ${op.handle}: register refused (${refusalText(reg)}) and login refused (${refusalText(login)})`);
      }
      op.userId = decodeJwtPayload(token).sub;
      const enrol = await ctx.edge.mutate('identity', 'totp.enrol', {}, token);
      if (!data(enrol)?.secret) throw new Error(`operator ${op.handle}: totp.enrol refused (${enrol.status}): ${refusalText(enrol)}`);
      op.pendingTotpSecret = data(enrol).secret;
      saveOperators(ctx, ops);
      const code = ctx.totp.totp(op.pendingTotpSecret);
      const confirm = await ctx.edge.mutate('identity', 'totp.confirm', { secret: op.pendingTotpSecret, code }, token);
      if (!data(confirm)?.ok) throw new Error(`operator ${op.handle}: totp.confirm refused (${confirm.status}): ${refusalText(confirm)}`);
      op.totpSecret = op.pendingTotpSecret;
      delete op.pendingTotpSecret;
      op.lastStep = stepNow();
      saveOperators(ctx, ops);
      ctx.log(`operator ${op.handle} enrolled a second factor (TOTP, sealed by identity)`);
    }
  }
  return ops;
}

/** Short-lived access token for this operator's live session, carrying an `admin:compliance` operator scope. */
async function mintOperatorToken(ctx, op, scopes = ['admin:compliance']) {
  const minted = await ctx.tokens.issueAccessToken(
    { userId: op.userId, sessionId: op.sessionId, scopes, tier: 'none', mfa: true },
    { secret: ctx.secrets.jwt, issuer: 'intafaced', audience: 'intafaced.api', accessTtlSeconds: 300 },
  );
  return minted.token;
}

/** Sign both operators in with their second factor. Returns { a, b } sessions with minted tokens. */
export async function operatorSessions(ctx) {
  const ops = await ensureOperators(ctx);
  return signInPair(ctx, ops, () => saveOperators(ctx, ops));
}

/** The vault's two enrolled LOCAL TEST founders as sign-ins keyed `a`/`b` (the keys their TOTP steps use), or none. */
export function founderSignIns(vault) {
  const pair = enrolledFounderPair(vault);
  return pair
    ? pair.map((f, i) => ({ key: ['a', 'b'][i], handle: f.handle, email: f.email, password: f.password, totpSecret: f.totpSecret }))
    : [];
}

/**
 * The pair that approves founder-only actions (opening a book, approving a verification). Once the stack's founders
 * are enrolled, identity refuses those from anyone else (action_approval.founder_only), so the founders sign in; on a
 * stack without them the test operators do. Founder credentials are read from the vault and never copied; only each
 * founder's last TOTP step is kept, in its own file, so a code is never replayed.
 */
export async function approverSessions(ctx) {
  const pair = founderSignIns(readJson(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), null));
  if (pair.length === 0) return operatorSessions(ctx);
  const stepsFile = path.join(ctx.paths.stateDir, FOUNDER_STEPS_NAME);
  const steps = readJson(stepsFile, {});
  const ops = {};
  for (const { key, ...f } of pair) ops[key] = { ...f, lastStep: Number(steps[key] ?? 0) };
  return signInPair(ctx, ops, () => writePrivate(stepsFile, { ...readJson(stepsFile, {}), a: ops.a.lastStep, b: ops.b.lastStep }));
}

/**
 * A TOTP code for founder `key` at a step after the last one any local tool used for that founder, recorded in
 * founder-totp-steps.json. Identity refuses a replayed step, and the world signs the founders in again right after the
 * gates do.
 */
export async function founderTotp(ctx, key, secret) {
  const stepsFile = path.join(ctx.paths.stateDir, FOUNDER_STEPS_NAME);
  const op = { totpSecret: secret, lastStep: Number(readJson(stepsFile, {})[key] ?? 0) };
  const code = await freshCode(ctx, op);
  writePrivate(stepsFile, { ...readJson(stepsFile, {}), [key]: op.lastStep });
  return code;
}

async function signInPair(ctx, ops, saveSteps) {
  const sessions = {};
  for (const l of ['a', 'b']) {
    const op = ops[l];
    const loginToken = await operatorLogin(ctx, op);
    saveSteps();
    sessions[l] = {
      op,
      /** Second-factor session token (what a signed-in operator holds). */
      token: loginToken,
      /** Same session, plus the operator scope. Short-lived. */
      async complianceToken() {
        return mintOperatorToken(ctx, op);
      },
      /**
       * Same session with an `admin:*` scope: what identity needs to see an OPERATOR principal. Four-eyes over
       * operator action types (matching.open, kyc.approve, ...) refuses a plain session token (an ordinary user,
       * #4724), so propose, approve and reject use this. Identity still checks the proposer and the approver are
       * two distinct users, so the two operators keep two distinct tokens. Accepted before and after that rule.
       */
      async approvalToken() {
        return mintOperatorToken(ctx, op);
      },
      /** Same session with the trade operator write scope svc-trade's admin doors check (admin.risk.set). */
      async tradeOpsToken() {
        return mintOperatorToken(ctx, op, ['admin:read', 'admin:write']);
      },
      /** Same session with the CRM scopes svc-ops checks before it asks identity whether the caller is a founder. */
      async crmToken() {
        return mintOperatorToken(ctx, op, ['ops:read', 'ops:write']);
      },
    };
  }
  return sessions;
}

/** Operator A proposes, operator B approves, with two different signed-in sessions. Returns { approvalId, operationId }. */
async function twoPerson(ctx, sessions, proposal) {
  // Two different people, or the approval proves nothing: refuse when the proposer and approver are the same operator
  // or cannot be told apart.
  const who = (s) => s.op?.handle ?? s.op?.email ?? null;
  if (who(sessions.a) === null || who(sessions.b) === null || who(sessions.a) === who(sessions.b))
    throw new Error('two-person approval needs two different operators: the proposer and the approver must differ');
  const proposed = await ctx.edge.mutate('identity', 'actionApproval.propose', proposal, await sessions.a.approvalToken());
  const row = data(proposed);
  if (!row?.approvalId) throw new Error(`actionApproval.propose refused (${proposed.status}): ${refusalText(proposed)}`);
  const approved = await ctx.edge.mutate(
    'identity',
    'actionApproval.approve',
    { approvalId: row.approvalId, expectedPayloadHash: proposal.payloadHash },
    await sessions.b.approvalToken(),
  );
  if (data(approved)?.status !== 'APPROVED')
    throw new Error(`actionApproval.approve refused (${approved.status}): ${refusalText(approved)}`);
  return { approvalId: row.approvalId, operationId: row.operationId };
}

// ── 1. Lifecycle (the owner stand-in) ───────────────────────────────────────

async function signedTrade(ctx, method, route, bodyObj) {
  if (method !== 'GET') assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
  const raw = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const headers = { ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw) };
  if (raw) headers['content-type'] = 'application/json';
  const res = await fetch(`${ctx.url('trade')}${route}`, {
    redirect: 'error',
    method,
    headers,
    body: raw || undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

export async function listMarkets(ctx) {
  const res = await ctx.edge.call('GET', '/api/v1/markets?limit=500');
  if (!Array.isArray(res.json)) throw new Error(`could not list markets (${res.status})`);
  return res.json;
}

export async function publishLifecycles(ctx) {
  const markets = openableMarkets(await listMarkets(ctx));
  const out = [];
  for (const m of markets) {
    const latest = await signedTrade(ctx, 'GET', `/internal/market-lifecycle/${encodeURIComponent(m.id)}`);
    const head = latest.status === 200 ? latest.json : null;
    if (head && lifecycleIsFresh(head.publication)) {
      out.push({ symbol: m.symbol, marketId: m.id, status: 'already published', evidenceId: head.evidenceId });
      continue;
    }
    const body = buildLifecyclePublication({ marketId: m.id, causalPredecessorId: head?.evidenceId ?? null });
    const res = await signedTrade(ctx, 'POST', '/internal/market-lifecycle', body);
    if (res.status !== 200) throw new Error(`lifecycle publish for ${m.symbol} refused (${res.status}): ${res.text.slice(0, 300)}`);
    out.push({ symbol: m.symbol, marketId: m.id, status: 'published', evidenceId: res.json.evidenceId });
    ctx.log(`lifecycle ${m.symbol}: published as ${P}owner-stand-in (${MARKERS.lifecycleLabel}); evidence ${res.json.evidenceId}`);
  }
  return out;
}

/** Same hash services/svc-bank/src/action-approval-consume.ts computes for a bank ops action (fields sorted by key). */
export function bankPayloadHash(actionType, fields) {
  const sorted = Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]]),
  );
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify({ actionType, fields: sorted }))
    .digest('hex')}`;
}

/**
 * LOCAL TEST personal transfer limits, per asset: not owner values. Without a published row svc-bank refuses every
 * personal send with bank.personal_transfer_terms_unset, so the stack publishes these through compliance's own door.
 */
export const TEST_TRANSFER_TERMS = [
  { assetId: 'USDT', perTransferLimit: '1000', dailyLimit: '5000', fee: '0' },
  { assetId: 'USDC', perTransferLimit: '1000', dailyLimit: '5000', fee: '0' },
];
export const PUBLISH_TERMS_ACTION = 'bank.ops.publishTransferTerms';

export function termsProposal(terms) {
  return {
    actionType: PUBLISH_TERMS_ACTION,
    targetService: 'svc-bank',
    targetId: PUBLISH_TERMS_ACTION,
    expectedVersion: '1',
    payloadHash: bankPayloadHash(PUBLISH_TERMS_ACTION, terms),
    policyVersion: MARKERS.policyVersion,
  };
}

// ── 2. Open the books in matching (two-person approval) ─────────────────────

export async function openBooks(ctx) {
  const matchingBase = ctx.url('matching');
  const listed = await fetch(`${matchingBase}/markets`, { redirect: 'error', signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
  const have = new Set((listed.markets ?? []).map((m) => (typeof m === 'string' ? m : (m.marketId ?? m.id))));
  const markets = openableMarkets(await listMarkets(ctx)).filter((m) => !have.has(m.id));
  const out = [];
  if (markets.length === 0) return out;
  const sessions = await approverSessions(ctx);
  for (const m of markets) {
    const ids = await twoPerson(ctx, sessions, openProposal(m.id));
    const raw = JSON.stringify({ operatorId: sessions.a.op.userId, approvalId: ids.approvalId, operationId: ids.operationId });
    assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
    const res = await fetch(`${matchingBase}/markets/${encodeURIComponent(m.id)}/open`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-trade', ctx.secrets.internal, raw) },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200 || body.accepted !== true)
      throw new Error(
        `matching open for ${m.symbol} refused (${res.status}): ${JSON.stringify(body).slice(0, 300)}` +
          (body.code === 'action_approval.not_operator'
            ? '\n  matching reads its operator seats when it starts; after the founders enrol, run: pnpm local:stack restart matching'
            : ''),
      );
    out.push({
      symbol: m.symbol,
      marketId: m.id,
      approvalId: ids.approvalId,
      operatorId: body.operatorId,
      confirmOperatorId: body.confirmOperatorId,
    });
    ctx.log(
      `matching open ${m.symbol}: accepted (operator ${body.operatorId}, confirmed by ${body.confirmOperatorId}; ${MARKERS.label}); approval ${ids.approvalId}`,
    );
  }
  return out;
}

// ── 2b. Personal transfer limits (two-person approval) ──────────────────────

/** One founder proposes, the other approves (identity keeps bank ops founder-only), the first publishes through svc-bank ops.publishTransferTerms. */
export async function publishTransferTerms(ctx) {
  const sessions = await approverSessions(ctx);
  const out = [];
  for (const terms of TEST_TRANSFER_TERMS) {
    const ids = await twoPerson(ctx, sessions, termsProposal(terms));
    assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
    const res = await ctx.edge.mutate('bank', 'ops.publishTransferTerms', { ...terms, ...ids }, await sessions.a.complianceToken());
    const row = data(res);
    if (!row?.publishedAt)
      throw new Error(`bank ops.publishTransferTerms for ${terms.assetId} refused (${res.status}): ${refusalText(res)}`);
    out.push({ ...terms, approvedBy: row.approvedBy, approvalId: ids.approvalId });
    ctx.log(
      `terms ${terms.assetId}: ${terms.perTransferLimit} per payment, ${terms.dailyLimit} a day, fee ${terms.fee} (${MARKERS.label}); approval ${ids.approvalId}`,
    );
  }
  return out;
}

/**
 * Halt (or resume) one book, through the door an operator uses: operator A proposes, operator B approves, and the
 * call is signed as svc-trade (the only caller matching accepts on this route). Resting orders stay; matching refuses
 * new submits on a halted book with `market_halted`, and cancels still work.
 */
export async function setBookHalt(ctx, symbol, halted) {
  const market = (await listMarkets(ctx)).find((m) => m.symbol === symbol);
  if (!market) throw new Error(`no market ${symbol}`);
  const action = halted ? 'halt' : 'resume';
  const sessions = await approverSessions(ctx);
  const ids = await twoPerson(ctx, sessions, bookProposal(action, market.id));
  const raw = JSON.stringify({ operatorId: sessions.a.op.userId, approvalId: ids.approvalId, operationId: ids.operationId });
  assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
  const res = await fetch(`${ctx.url('matching')}/markets/${encodeURIComponent(market.id)}/${action}`, {
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-trade', ctx.secrets.internal, raw) },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || body.accepted !== true || body.halted !== halted)
    throw new Error(`matching ${action} for ${symbol} refused (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
  ctx.log(`matching ${action} ${symbol}: accepted (operator ${body.operatorId}, confirmed by ${body.confirmOperatorId}; ${MARKERS.label})`);
  return { symbol, marketId: market.id, halted: body.halted, approvalId: ids.approvalId };
}

// ── 2c. Supported assets and networks (two-person approval) ─────────────────

/**
 * LOCAL TEST registry rows: not owner values. The ledger's asset registry starts blank (W-balances-05), and with no
 * published row the address book offers no asset and refuses every save. Both networks are EVM chains, the only
 * address form the address book checks today.
 */
export const TEST_ASSET_ROWS = ['USDT', 'USDC'].map((id) => ({
  id,
  kind: 'crypto',
  precision: 6,
  networks: [
    { networkId: 'ethereum', label: 'TEST Ethereum' },
    { networkId: 'base', label: 'TEST Base' },
  ],
  defaultNetworkId: 'ethereum',
  allowedActions: ['deposit', 'withdraw', 'trade', 'transfer'],
  state: 'active',
}));
export const ASSET_EDIT_ACTION = 'ledger.asset_edit';

/** True when the published row already says what the TEST row says (revision and clock aside). */
export function assetRowMatches(row, want) {
  if (!row) return false;
  const pick = (r) =>
    JSON.stringify([
      r.kind,
      r.precision,
      Array.isArray(r.networks) ? r.networks.map((n) => [n.networkId, n.label]) : null,
      r.defaultNetworkId,
      [...(r.allowedActions ?? [])].sort(),
      r.state,
    ]);
  return pick(row) === pick(want);
}

export function assetEditProposal(edit, revision, payloadHash) {
  return {
    actionType: ASSET_EDIT_ACTION,
    targetService: 'svc-ledger',
    targetId: edit.id,
    expectedVersion: String(revision),
    payloadHash,
    policyVersion: MARKERS.policyVersion,
  };
}

async function treasuryCall(ctx, op, method, route, body) {
  if (method !== 'GET') assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
  const token = await mintOperatorToken(ctx, op, ['admin:treasury']);
  const res = await fetch(`${ctx.url('ledger')}${route}`, {
    redirect: 'error',
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

/**
 * Publish each TEST row through the founders' door: one founder proposes `ledger.asset_edit` for the row's current
 * revision, the other approves, and the first applies it at svc-ledger POST /operator/assets/apply-edit
 * (admin:treasury, second factor). A row that already says the same is left alone.
 */
export async function publishAssetRegistry(ctx) {
  const sessions = await approverSessions(ctx);
  const listed = await treasuryCall(ctx, sessions.a.op, 'GET', '/operator/assets');
  if (listed.status !== 200 || !Array.isArray(listed.json?.assets))
    throw new Error(`ledger GET /operator/assets refused (${listed.status}): ${listed.text.slice(0, 300)}`);
  const out = [];
  for (const want of TEST_ASSET_ROWS) {
    const row = listed.json.assets.find((a) => a.id === want.id) ?? null;
    if (assetRowMatches(row, want)) {
      out.push({ assetId: want.id, status: 'already published', revision: row.revision });
      continue;
    }
    const edit = { ...want, reason: `${MARKERS.label}: TEST asset and networks` };
    const revision = row?.revision ?? 0;
    const ids = await twoPerson(ctx, sessions, assetEditProposal(edit, revision, ctx.contracts.assetEditPayloadHash(edit)));
    const res = await treasuryCall(ctx, sessions.a.op, 'POST', '/operator/assets/apply-edit', { ...ids, edit });
    if (res.status !== 200) throw new Error(`ledger apply-edit for ${want.id} refused (${res.status}): ${res.text.slice(0, 300)}`);
    out.push({ assetId: want.id, status: 'published', revision: res.json?.revision ?? revision + 1, approvalId: ids.approvalId });
    ctx.log(
      `asset ${want.id}: ${want.networks.map((n) => n.networkId).join(', ')} published (${MARKERS.label}); approval ${ids.approvalId}`,
    );
  }
  return out;
}

// ── 2d. Pair price band and open-order cap (two-person approval) ────────────

/**
 * LOCAL TEST operator limits for every openable market: not owner values. A price band of 10% around the middle of
 * the book, and 20 open orders per account per market (the TEST market maker's ladder re-places at most 12). Written
 * through svc-trade's own door (admin.risk.set) with a second operator's approval, as a new version on top of what is
 * there; the other limits on the row are kept as they are.
 */
export const TEST_RISK_LIMITS = { collar: '0.1', throttle: '20' };
export const RISK_SET_ACTION = 'trade.risk_set';

/** Keys sorted, no spaces, null for an unset value: the form svc-trade hashes (services/svc-trade/src/admin/common.ts). */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** The hash svc-trade recomputes when it consumes a trade.risk_set approval. */
export function riskSetPayloadHash({ market, limits, expectedVersion, reason }) {
  const body = { actionType: RISK_SET_ACTION, market, limits, expectedVersion, reason };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

export function riskSetProposal(body) {
  return {
    actionType: RISK_SET_ACTION,
    targetService: 'svc-trade',
    targetId: body.market,
    expectedVersion: body.expectedVersion,
    payloadHash: riskSetPayloadHash(body),
    policyVersion: MARKERS.policyVersion,
  };
}

/**
 * Write one new version of a market's operator limits: `changes` replaces only the fields it names (null clears one).
 * Returns the written row. Nothing is written when the row already says the same.
 */
export async function setPairRisk(ctx, symbol, changes, sessions = null) {
  const market = (await listMarkets(ctx)).find((m) => m.symbol === symbol);
  if (!market) throw new Error(`no market ${symbol}`);
  const pair = sessions ?? (await approverSessions(ctx));
  const current = data(await ctx.edge.query('trade', 'admin.risk.get', { market: market.id }, await pair.a.tradeOpsToken()));
  if (!current?.version) throw new Error(`trade admin.risk.get for ${symbol} gave no version`);
  const fields = ['collar', 'fatFinger', 'slippageCap', 'throttle', 'circuitBreaker'];
  const limits = Object.fromEntries(fields.map((f) => [f, f in changes ? changes[f] : (current[f] ?? null)]));
  if (fields.every((f) => limits[f] === (current[f] ?? null)))
    return { symbol, marketId: market.id, version: current.version, changed: false, limits };
  const body = { market: market.id, limits, expectedVersion: current.version, reason: `${MARKERS.label}: TEST pair limits` };
  const ids = await twoPerson(ctx, pair, riskSetProposal(body));
  assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.risk.set',
    { ...body, approvalId: ids.approvalId, operationId: ids.operationId },
    await pair.a.tradeOpsToken(),
  );
  const row = data(res);
  if (!row?.version) throw new Error(`trade admin.risk.set for ${symbol} refused (${res.status}): ${refusalText(res)}`);
  ctx.log(
    `pair limits ${symbol}: version ${row.version}, band ${row.collar ?? 'not set'}, cap ${row.throttle ?? 'not set'} (${MARKERS.label}); approval ${ids.approvalId}`,
  );
  return { symbol, marketId: market.id, version: row.version, changed: true, limits };
}

/** Publish the TEST band and cap on every openable market that does not carry them yet. */
export async function publishPairRisk(ctx) {
  const markets = openableMarkets(await listMarkets(ctx));
  if (markets.length === 0) return [];
  const sessions = await approverSessions(ctx);
  const out = [];
  for (const m of markets) out.push(await setPairRisk(ctx, m.symbol, TEST_RISK_LIMITS, sessions));
  return out;
}

// ── 2e. TEST perpetual and derivatives terms (two-person approval) ──────────

/** The labelled TEST perpetual's fixture (seed-futures-test-listing.mjs reads and checks it). */
export const TEST_FUTURES_FIXTURE = 'services/svc-trade/fixtures/btc-usdt-swap.TEST.json';
/** Region the stack's Edge stamps on every request (svc-edge DEFAULT_REGION, unset on this stack). */
export const TEST_AGREEMENT_REGION = 'XX';
export const AGREEMENT_PUBLISH_ACTION = 'trade.agreement_publish';
export const ELIGIBILITY_RULES_ACTION = 'trade.derivatives_eligibility_rules_set';

export function agreementPublishHash({ kind, expectedVersion, texts, reason }) {
  const sha = (body) => `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
  const rows = texts
    .map((t) => ({ region: t.region.trim().toUpperCase(), title: t.title.trim(), bodySha256: sha(t.body.trim()) }))
    .sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  const body = { actionType: AGREEMENT_PUBLISH_ACTION, kind, expectedVersion, texts: rows, reason };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

export function eligibilityRulesHash({ questions, passMark, minKycTier, expectedVersion, reason }) {
  const body = { actionType: ELIGIBILITY_RULES_ACTION, expectedVersion, questions, passMark, minKycTier, reason };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

/** svc-trade's own role on the stack's database: loopback, the marker's postgres port, the stack's secret. */
function localDbUrl(ctx) {
  return `postgres://svc_trade:${encodeURIComponent(ctx.secrets.pgService)}@${HOST}:${ctx.marker.ports.postgres ?? 15460}/${DB_NAME}`;
}

/** Insert the TEST perpetual once, through the repo's own seed tool (it refuses any database that is not local). */
export async function seedFuturesListing(ctx) {
  const { createRequire } = await import('node:module');
  const postgres = createRequire(path.join(REPO, 'services', 'svc-trade', 'package.json'))('postgres');
  const { evaluateSeedRequest, insertFuturesTestListing } = await import('./seed-futures-test-listing.mjs');
  const fixturePath = path.join(REPO, TEST_FUTURES_FIXTURE);
  const env = { TRADE_DATABASE_URL: localDbUrl(ctx) };
  const decision = evaluateSeedRequest({ env, fixturePath, fixtureText: fs.readFileSync(fixturePath, 'utf8') });
  assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
  const sql = postgres(decision.databaseUrl, { max: 1, onnotice: () => {} });
  try {
    // Upserts only a row that is itself a TEST listing; a real listing of the same symbol is refused, never overwritten.
    const row = await insertFuturesTestListing(sql, decision.listing);
    ctx.log(`TEST perpetual ${row.symbol} listed as ${row.id} (${MARKERS.label})`);
    return { symbol: row.symbol, marketId: row.id };
  } finally {
    await sql.end();
  }
}

/** List the TEST spot markets (`TEST_SPOT_LISTINGS`) once each, through the repo's own seed tool. */
export async function seedSpotTestListings(ctx) {
  const { createRequire } = await import('node:module');
  const postgres = createRequire(path.join(REPO, 'services', 'svc-trade', 'package.json'))('postgres');
  const { TEST_SPOT_LISTINGS, localTestDatabaseUrl, insertSpotTestListing } = await import('./seed-spot-test-listing.mjs');
  const databaseUrl = localTestDatabaseUrl(localDbUrl(ctx));
  assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const out = [];
  try {
    for (const listing of TEST_SPOT_LISTINGS) {
      // Upserts only a row that is itself a TEST listing; a real listing of the same symbol is refused, never overwritten.
      const row = await insertSpotTestListing(sql, listing);
      ctx.log(`TEST spot ${row.symbol} listed as ${row.id} (${MARKERS.label})`);
      out.push({ symbol: row.symbol, marketId: row.id });
    }
    return out;
  } finally {
    await sql.end();
  }
}

/** Publish the TEST agreements and quiz once each, through svc-trade's own doors with a second operator's approval. */
export async function publishFuturesTerms(ctx) {
  const pair = await approverSessions(ctx);
  const out = [];
  for (const [kind, text] of Object.entries(TEST_AGREEMENTS)) {
    const current = data(await ctx.edge.query('trade', 'admin.agreements.get', { kind }, await pair.a.tradeOpsToken()));
    if (!current) throw new Error(`trade admin.agreements.get ${kind} gave no answer`);
    if (current.current) {
      out.push({ what: kind, version: current.current.version, changed: false });
      continue;
    }
    const expectedVersion = String(current.history?.[0]?.version ?? 0);
    const texts = [{ region: TEST_AGREEMENT_REGION, ...text }];
    const reason = `${MARKERS.label}: TEST ${kind} text`;
    const ids = await twoPerson(ctx, pair, {
      actionType: AGREEMENT_PUBLISH_ACTION,
      targetService: 'svc-trade',
      targetId: `agreement:${kind}`,
      expectedVersion,
      payloadHash: agreementPublishHash({ kind, expectedVersion, texts, reason }),
      policyVersion: MARKERS.policyVersion,
    });
    assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
    const res = await ctx.edge.mutate(
      'trade',
      'admin.agreements.publish',
      { kind, texts, expectedVersion, reason, approvalId: ids.approvalId, clientRequestId: ids.operationId },
      await pair.a.tradeOpsToken(),
    );
    const row = data(res);
    if (!row?.version) throw new Error(`trade admin.agreements.publish ${kind} refused (${res.status}): ${refusalText(res)}`);
    out.push({ what: kind, version: row.version, changed: true });
  }
  const rules = data(await ctx.edge.query('trade', 'admin.eligibilityRules.get', undefined, await pair.a.tradeOpsToken()));
  if (!rules) throw new Error('trade admin.eligibilityRules.get gave no answer');
  if (rules.version != null) {
    out.push({ what: 'eligibility', version: rules.version, changed: false });
  } else {
    const expectedVersion = '0';
    const reason = `${MARKERS.label}: TEST derivatives quiz`;
    const content = TEST_ELIGIBILITY_RULES;
    const ids = await twoPerson(ctx, pair, {
      actionType: ELIGIBILITY_RULES_ACTION,
      targetService: 'svc-trade',
      targetId: 'derivatives_eligibility_rules',
      expectedVersion,
      payloadHash: eligibilityRulesHash({ ...content, expectedVersion, reason }),
      policyVersion: MARKERS.policyVersion,
    });
    assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
    const res = await ctx.edge.mutate(
      'trade',
      'admin.eligibilityRules.set',
      { ...content, expectedVersion, reason, approvalId: ids.approvalId, clientRequestId: ids.operationId },
      await pair.a.tradeOpsToken(),
    );
    const row = data(res);
    if (!row?.version) throw new Error(`trade admin.eligibilityRules.set refused (${res.status}): ${refusalText(res)}`);
    out.push({ what: 'eligibility', version: row.version, changed: true });
  }
  for (const r of out)
    ctx.log(`derivatives terms ${r.what}: version ${r.version}${r.changed ? '' : ' (already published)'} (${MARKERS.label})`);
  return out;
}

// ── 2f. Charts owner values (C-ops-04): LOCAL TEST values through svc-trade's own door ──

/**
 * LOCAL TEST charts owner values. Not owner values, and not product defaults: they let the charts journeys run on the
 * local test stack. Counts go through `admin.chartOwnerValues.set` with the stack's operator A (admin:write, a reason, a
 * business key); a count needs no second operator. The data class goes through the same door with a second operator's
 * approval, as the owner's flow does. IFC/USDT is left unset on purpose, so a journey can see the blank refusal.
 */
export const TEST_CHART_COUNTS = Object.freeze({
  compareCap: 3,
  chartCountLimit: 4,
  drawingCap: 50,
  brushPointCap: 2000,
  delayedBoundarySeconds: 30,
  renderBudgetMs: 500,
});
export const CHART_DATA_CLASSES_ALLOWED = Object.freeze(['real_time', 'delayed', 'end_of_day']);
export const TEST_CHART_DATA_CLASSES = Object.freeze({ 'BTC/USDT': 'real_time', 'ETH/USDT': 'real_time' });
export const CHART_DATA_CLASS_ACTION = 'trade.chart_data_class_set';

/** The hash svc-trade recomputes for a data class approval (services/svc-trade/src/admin/chart-owner-values.ts). */
export function chartDataClassPayloadHash({ symbol, dataClass, expectedVersion, reason }) {
  const body = { actionType: CHART_DATA_CLASS_ACTION, symbol, dataClass, expectedVersion, reason };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

/**
 * The policy version the founder page's proposal carries (apps/admin/src/lib/trade-ops/charts-owner-values-model.ts,
 * CHART_DATA_CLASS_POLICY_VERSION). Identity stores policy_version and does not check it, and svc-trade's
 * consumeApproval does not check it either, so the stand-in uses the same value as the real flow.
 */
export const CHART_DATA_CLASS_POLICY_VERSION = 'trade-chart-data-class-v1';

export function chartDataClassProposal(body) {
  return {
    actionType: CHART_DATA_CLASS_ACTION,
    targetService: 'svc-trade',
    targetId: body.symbol,
    expectedVersion: body.expectedVersion,
    payloadHash: chartDataClassPayloadHash(body),
    policyVersion: CHART_DATA_CLASS_POLICY_VERSION,
  };
}

async function readChartValues(ctx, token) {
  const res = await ctx.edge.query('trade', 'admin.chartOwnerValues.get', {}, token);
  const view = data(res);
  if (!view?.scalars) throw new Error(`trade admin.chartOwnerValues.get refused (${res.status}): ${refusalText(res)}`);
  return view;
}

/** Set each TEST count that is not set yet. One write per count, each under a business key, each with a reason. */
export async function publishChartCounts(ctx, sessions = null) {
  const pair = sessions ?? (await approverSessions(ctx));
  let view = await readChartValues(ctx, await pair.a.tradeOpsToken());
  const out = [];
  for (const [key, value] of Object.entries(TEST_CHART_COUNTS)) {
    if (view.scalars.values[key] === value) {
      out.push({ key, value, changed: false, version: view.scalars.version });
      continue;
    }
    const expectedVersion = view.scalars.version ?? '0';
    const res = await ctx.edge.mutate(
      'trade',
      'admin.chartOwnerValues.set',
      {
        key,
        value,
        expectedVersion,
        reason: `${MARKERS.label}: TEST charts ${key}`,
        clientRequestId: `${MARKERS.idPrefix}charts:${key}:v${expectedVersion}:${value}`,
      },
      await pair.a.tradeOpsToken(),
    );
    view = data(res);
    if (!view?.scalars) throw new Error(`trade admin.chartOwnerValues.set ${key} refused (${res.status}): ${refusalText(res)}`);
    out.push({ key, value, changed: true, version: view.scalars.version });
  }
  return out;
}

/**
 * Set each data class that differs from `classes` (the TEST map by default). Two operators: A proposes the exact change,
 * B approves it, A writes it. A journey step that needs a class other than the default (J-charts-desk-02 #2 sets a
 * market to delayed) calls this through `chart-class`, and sets it back afterwards the same way.
 */
export async function publishChartDataClasses(ctx, sessions = null, classes = TEST_CHART_DATA_CLASSES) {
  const pair = sessions ?? (await approverSessions(ctx));
  let view = await readChartValues(ctx, await pair.a.tradeOpsToken());
  const out = [];
  for (const [symbol, dataClass] of Object.entries(classes)) {
    const row = view.dataClasses.find((r) => r.symbol === symbol);
    if (!row) throw new Error(`no market ${symbol} is listed on this stack, so it has no data class to set`);
    if (row.dataClass === dataClass) {
      out.push({ symbol, dataClass, changed: false });
      continue;
    }
    const body = { symbol, dataClass, expectedVersion: row.version ?? '0', reason: `${MARKERS.label}: TEST data class` };
    const ids = await twoPerson(ctx, pair, chartDataClassProposal(body));
    assertActiveLocalStack({ stateDir: ctx.paths.stateDir });
    const res = await ctx.edge.mutate(
      'trade',
      'admin.chartOwnerValues.set',
      {
        key: 'dataClass',
        symbol,
        value: dataClass,
        expectedVersion: body.expectedVersion,
        reason: body.reason,
        approvalId: ids.approvalId,
        clientRequestId: ids.operationId,
      },
      await pair.a.tradeOpsToken(),
    );
    view = data(res);
    if (!view?.scalars)
      throw new Error(`trade admin.chartOwnerValues.set dataClass ${symbol} refused (${res.status}): ${refusalText(res)}`);
    out.push({ symbol, dataClass, changed: true, approvalId: ids.approvalId });
  }
  return out;
}

export async function publishCharts(ctx) {
  const pair = await approverSessions(ctx);
  return { counts: await publishChartCounts(ctx, pair), dataClasses: await publishChartDataClasses(ctx, pair) };
}

/** One line per value. Every line says TEST, and the blank market is named, so nobody reads a TEST value as a real one. */
function sayCharts(report) {
  for (const c of report.counts)
    say(`  charts    ${c.key.padEnd(24)} ${c.changed ? `set to ${c.value} (TEST), version ${c.version}` : `already ${c.value} (TEST)`}`);
  for (const d of report.dataClasses)
    say(
      `  charts    ${d.symbol.padEnd(24)} ${d.changed ? `data class ${d.dataClass} (TEST), approval ${d.approvalId}` : `already ${d.dataClass} (TEST)`}`,
    );
  say('  charts    IFC/USDT stays not set on purpose (no TEST value): a journey sees the blank refusal');
}

// ── 3. Verification tier ────────────────────────────────────────────────────

/** Accounts whose credentials this stack holds (it created them), keyed by handle. */
export function ownedAccounts(ctx) {
  const p = ctx.paths;
  const m = readJson(p.marketAccounts, {});
  const w = readJson(p.worldAccounts, {});
  return [m.maker, m.taker, w.friend].filter((a) => a?.email && a?.password);
}

/**
 * Owned accounts submit their own `full` request through identity (nobody else can submit for them). With `founders`,
 * the two enrolled LOCAL TEST founders do too: the founder console reads bank and P2P desks whose access gate checks
 * the caller's own verification tier. A founder signs in with its second factor, at a step `founderTotp` never replays.
 */
export async function submitOwnedAccounts(ctx, { users, approved, pending }, { founders = false } = {}) {
  const out = [];
  const pendingUsers = new Set(pending.filter((r) => r.tier === 'full').map((r) => r.userId));
  const founderAccounts = founders ? founderSignIns(readJson(path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME), null)) : [];
  for (const acct of [...ownedAccounts(ctx), ...founderAccounts]) {
    const u = users.find((x) => x.email.toLowerCase() === String(acct.email).toLowerCase());
    if (!u) continue;
    const has = approved.get(u.id) ?? new Set();
    if (has.has('full') || has.has('institutional') || pendingUsers.has(u.id)) continue;
    const totpCode = acct.key ? await founderTotp(ctx, acct.key, acct.totpSecret) : undefined;
    const login = await ctx.edge.mutate('identity', 'auth.login', {
      identifier: acct.email,
      password: acct.password,
      ...(totpCode ? { totpCode } : {}),
    });
    const token = data(login)?.accessToken;
    if (!token) {
      out.push({ handle: u.handle, ok: false, why: `login refused: ${refusalText(login)}` });
      continue;
    }
    const sub = await ctx.edge.mutate('identity', 'kyc.submit', { tier: 'full', jurisdiction: MARKERS.kycJurisdiction }, token);
    out.push({ handle: u.handle, ok: Boolean(data(sub)?.id), why: data(sub)?.id ? 'submitted' : refusalText(sub) });
  }
  return out;
}

/** Pending `full`/`basic` records to approve; with `userIds`, only those users' records. */
export function selectPendingForApproval(pending, userIds = null) {
  return pending.filter((r) => (r.tier === 'full' || r.tier === 'basic') && (!userIds || userIds.includes(r.userId)));
}

/**
 * Approve pending `full`/`basic` records through the two-person path. Returns one row per record.
 * `userIds` limits it to those users, so a request that arrives while this runs is never approved by accident.
 */
export async function approvePending(ctx, sessions = null, { userIds = null } = {}) {
  const secrets = ctx.secrets;
  const { users, pending } = listAccountsAndTiers(secrets);
  const todo = selectPendingForApproval(pending, userIds);
  const out = [];
  if (todo.length === 0) return out;
  const s = sessions ?? (await approverSessions(ctx));
  let operators = null;
  for (const r of todo) {
    const who = users.find((u) => u.id === r.userId)?.handle ?? r.userId;
    try {
      // Identity refuses a KYC decision by its own subject (auth.kyc_self_review), so a founder's own request is
      // decided by the two TEST operators (kyc.* is an operator action), never by the founder pair it belongs to.
      const own = r.userId === s.a.op.userId || r.userId === s.b.op.userId;
      const pair = own ? (operators ??= await operatorSessions(ctx)) : s;
      const ids = await twoPerson(ctx, pair, kycApproveProposal(r.id));
      const token = await pair.a.complianceToken();
      const res = await ctx.edge.mutate(
        'identity',
        'kyc.approve',
        { recordId: r.id, approvalId: ids.approvalId, operationId: ids.operationId },
        token,
      );
      const ok = data(res)?.status === 'approved';
      out.push({ handle: who, recordId: r.id, tier: r.tier, ok, why: ok ? 'approved' : refusalText(res) });
      ctx.log(
        ok
          ? `verify ${who}: ${r.tier} approved by ${pair.a.op.handle}, confirmed by ${pair.b.op.handle} (${MARKERS.label}); record ${r.id}`
          : `verify ${who}: REFUSED ${refusalText(res)}`,
      );
    } catch (err) {
      out.push({ handle: who, recordId: r.id, tier: r.tier, ok: false, why: String(err.message ?? err) });
      ctx.log(`verify ${who}: FAILED ${String(err.message ?? err).slice(0, 300)}`);
    }
  }
  return out;
}

/** Submit what this stack can submit for itself, then approve everything pending. */
export async function verifyAll(ctx) {
  const before = listAccountsAndTiers(ctx.secrets);
  const submitted = await submitOwnedAccounts(ctx, before, { founders: true });
  for (const s of submitted) ctx.log(`verify ${s.handle}: ${s.ok ? 'submitted its own full request' : `could not submit: ${s.why}`}`);
  const approvedRows = await approvePending(ctx);
  const after = listAccountsAndTiers(ctx.secrets);
  const waiting = needsFullTier(
    after.users.filter((u) => !u.handle.startsWith(MARKERS.operatorHandlePrefix)),
    after.approved,
  ).map((u) => u.handle);
  return { submitted, approved: approvedRows, stillWithoutFull: waiting };
}

// ── Status ──────────────────────────────────────────────────────────────────

export async function status(ctx) {
  const markets = openableMarkets(await listMarkets(ctx));
  const matching = await fetch(`${ctx.url('matching')}/markets`, { redirect: 'error' })
    .then((r) => r.json())
    .catch(() => ({ markets: [] }));
  const listed = new Set((matching.markets ?? []).map((m) => (typeof m === 'string' ? m : (m.marketId ?? m.id))));
  const { users, approved, pending } = listAccountsAndTiers(ctx.secrets);
  return {
    label: MARKERS.label,
    markets: markets.map((m) => ({
      symbol: m.symbol,
      lifecycleState: m.lifecycle?.state,
      reason: m.lifecycle?.reasonCode,
      listedInMatching: listed.has(m.id),
    })),
    accounts: users.map((u) => ({
      handle: u.handle,
      tiers: [...(approved.get(u.id) ?? [])],
      pending: pending.filter((r) => r.userId === u.id).length,
    })),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`\nlocal-test-gates: ${msg}\n`);
  process.exit(code);
}

async function main() {
  const cmd = process.argv[2] ?? 'status';
  let ctx;
  try {
    ctx = await makeContext();
  } catch (err) {
    die(String(err.message ?? err));
  }
  say(`LOCAL TEST GATES — ${MARKERS.label}`);
  try {
    if (cmd === 'operators') {
      const ops = await ensureOperators(ctx);
      say(`operators ready: ${ops.a.handle}, ${ops.b.handle} (credentials in ${ctx.paths.operators}, mode 600)`);
    } else if (cmd === 'lifecycle') {
      for (const r of await publishLifecycles(ctx)) say(`  ${r.symbol.padEnd(10)} ${r.status}  evidence ${r.evidenceId}`);
    } else if (cmd === 'open') {
      const rows = await openBooks(ctx);
      say(
        rows.length
          ? rows.map((r) => `  ${r.symbol} opened (approval ${r.approvalId})`).join('\n')
          : '  every openable market is already listed in matching',
      );
    } else if (cmd === 'verify') {
      const r = await verifyAll(ctx);
      for (const a of r.approved) say(`  ${a.ok ? 'OK     ' : 'REFUSED'} ${a.handle} ${a.tier}: ${a.why}`);
      if (r.approved.length === 0) say('  no pending verification requests');
      if (r.stillWithoutFull.length)
        say(
          `  still without a verified tier (must submit the request themselves, e.g. tap Verify in the app): ${r.stillWithoutFull.join(', ')}`,
        );
    } else if (cmd === 'terms') {
      for (const r of await publishTransferTerms(ctx)) say(`  terms     ${r.assetId.padEnd(10)} published, approved by ${r.approvedBy}`);
    } else if (cmd === 'futures') {
      await seedFuturesListing(ctx);
      await publishFuturesTerms(ctx);
    } else if (cmd === 'apply') {
      // The TEST perpetual and TEST spot markets are listed first, so the lifecycle, book and limit steps below include it.
      await seedFuturesListing(ctx);
      await seedSpotTestListings(ctx);
      await publishFuturesTerms(ctx);
      for (const r of await publishLifecycles(ctx)) say(`  lifecycle ${r.symbol.padEnd(10)} ${r.status}`);
      for (const r of await openBooks(ctx)) say(`  open      ${r.symbol.padEnd(10)} accepted`);
      for (const r of await publishTransferTerms(ctx)) say(`  terms     ${r.assetId.padEnd(10)} published`);
      for (const r of await publishAssetRegistry(ctx)) say(`  asset     ${r.assetId.padEnd(10)} ${r.status}`);
      for (const r of await publishPairRisk(ctx))
        say(`  limits    ${r.symbol.padEnd(10)} ${r.changed ? `version ${r.version}` : 'already published'}`);
      sayCharts(await publishCharts(ctx));
      const v = await verifyAll(ctx);
      for (const a of v.approved) say(`  verify    ${a.handle} ${a.tier}: ${a.ok ? 'approved' : a.why}`);
      if (v.stillWithoutFull.length)
        say(`  still without a verified tier (they must submit the request themselves): ${v.stillWithoutFull.join(', ')}`);
    } else if (cmd === 'assets') {
      for (const r of await publishAssetRegistry(ctx)) say(`  asset     ${r.assetId.padEnd(10)} ${r.status} (revision ${r.revision})`);
    } else if (cmd === 'halt' || cmd === 'resume') {
      const symbol = process.argv[3];
      if (!symbol) die(`usage: local-test-gates.mjs ${cmd} <SYMBOL>, for example ETH/USDT`, 2);
      const r = await setBookHalt(ctx, symbol, cmd === 'halt');
      say(`  ${r.symbol} ${r.halted ? 'halted' : 'resumed'} (approval ${r.approvalId})`);
    } else if (cmd === 'limits') {
      for (const r of await publishPairRisk(ctx))
        say(`  limits    ${r.symbol.padEnd(10)} ${r.changed ? `version ${r.version}` : 'already published'}`);
    } else if (cmd === 'charts') {
      sayCharts(await publishCharts(ctx));
    } else if (cmd === 'chart-class') {
      // chart-class <SYMBOL> <dataClass>: one market's data class on the local stack, through the same two-person approval.
      const [symbol, dataClass] = process.argv.slice(3);
      if (!symbol || !CHART_DATA_CLASSES_ALLOWED.includes(dataClass))
        die('usage: local-test-gates.mjs chart-class <SYMBOL> real_time|delayed|end_of_day', 2);
      // Only the TEST markets the stack lists for the charts journeys (never IFC/USDT or any real market).
      if (!Object.hasOwn(TEST_CHART_DATA_CLASSES, symbol))
        die(`chart-class refuses ${symbol}: only the TEST markets (${Object.keys(TEST_CHART_DATA_CLASSES).join(', ')}) can be changed`, 2);
      const [d] = await publishChartDataClasses(ctx, null, { [symbol]: dataClass });
      say(
        `  charts    ${d.symbol.padEnd(24)} ${d.changed ? `data class ${d.dataClass} (TEST), approval ${d.approvalId}` : `already ${d.dataClass} (TEST)`}`,
      );
    } else if (cmd === 'risk') {
      // risk <SYMBOL> <field>=<value|unset> ...: a journey step's own change to one market's limits.
      const symbol = process.argv[3];
      const pairs = process.argv.slice(4);
      if (!symbol || pairs.length === 0) die('usage: local-test-gates.mjs risk <SYMBOL> collar=0.1|unset throttle=20|unset ...', 2);
      const changes = {};
      for (const p of pairs) {
        const [k, v] = p.split('=');
        if (!['collar', 'fatFinger', 'slippageCap', 'throttle', 'circuitBreaker'].includes(k) || v === undefined)
          die(`not a limit: ${p}`, 2);
        changes[k] = v === 'unset' ? null : v;
      }
      const r = await setPairRisk(ctx, symbol, changes);
      say(`  ${r.symbol} limits ${r.changed ? `now version ${r.version}` : 'unchanged'}: ${JSON.stringify(r.limits)}`);
    } else if (cmd === 'status') {
      say(JSON.stringify(await status(ctx), null, 2));
    } else {
      die(
        'usage: local-test-gates.mjs apply | operators | lifecycle | open | terms | assets | futures | limits | charts | chart-class <SYMBOL> <dataClass> | risk <SYMBOL> k=v... | verify | halt <SYMBOL> | resume <SYMBOL> | status',
        2,
      );
    }
  } catch (err) {
    die(String(err.message ?? err));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
