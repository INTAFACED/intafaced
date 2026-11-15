import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { totpNow } from '../../../../tooling/scripts/local-founder-seed.mjs';
import { LOCAL_TEST_DEVICE_KEY, localTestAdminDeviceCookie } from '../../../../tooling/scripts/local-test-facts.mjs';
import { ADMIN, assertAdminUp } from './admin.mjs';
import { signUpInBrowser } from './stack.mjs';

// TEST staff in the founder console (OWNER 44). Identity's labelled TEST roster (tooling/profiles/test-owner-values/
// identity.json, IDENTITY_STAFF_TEST_ROSTER, read only with APP_ENV dev or test) names one member per role by email. A member
// is an ordinary account with that confirmed email and a second factor: its signed-in session then gets the role's TEST
// scopes and staff permissions, and the console admits it as staff, not as a founder.
//
// The first journey that needs a role makes its member the way anyone joins: sign-up in the customer app, the mailed code,
// then an authenticator through identity's own totp.enrol and totp.confirm. The password and the authenticator secret are
// kept only in <state>/staff-test.json (mode 600), so later journeys on the same stack sign the same person in. A lock file
// beside it keeps two workers from making the same member twice or spending the same code step.

/** The roles the TEST roster defines, each with its one member. */
export const STAFF_TEST_MEMBERS = {
  support: 'local-test-staff-support@local-test.invalid',
  compliance: 'local-test-staff-compliance@local-test.invalid',
  risk: 'local-test-staff-risk@local-test.invalid',
  finance: 'local-test-staff-finance@local-test.invalid',
};

const VAULT_NAME = 'staff-test.json';
const VAULT_KIND = 'intafaced-local-test-staff';
const STEP_MS = 30_000;

function writePrivate(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readVault(file) {
  if (!existsSync(file)) return { kind: VAULT_KIND, staff: {} };
  const vault = JSON.parse(readFileSync(file, 'utf8'));
  if (vault?.kind !== VAULT_KIND || typeof vault.staff !== 'object') throw new Error(`${file} is not a local test staff vault`);
  return vault;
}

/** Runs `fn` holding the vault's lock file, so one worker at a time makes a member or takes a code step. */
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const until = Date.now() + 180_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() > until) throw new Error(`${lock} has been held for 3 minutes: another run stopped while holding it; remove it`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await fn();
  } finally {
    unlinkSync(lock);
  }
}

/** One identity procedure through the stack's Edge, as the founder seed calls it; a refusal throws with its typed code. */
async function identity(edge, procedure, input, token) {
  const res = await fetch(`${edge}/api/identity/trpc/${procedure}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  const data = body?.result?.data;
  if (!res.ok || data === undefined) {
    const err = body?.error?.json ?? body?.error ?? {};
    const code = err?.data?.appCode ?? err?.data?.cause?.code ?? err?.message ?? 'no body';
    // Never print the body of a sign-in: a half-good one carries a token.
    throw new Error(`identity ${procedure} refused (${res.status}): ${String(code).slice(0, 160)}`);
  }
  return data && typeof data === 'object' && 'json' in data ? data.json : data;
}

/** A code from a step after the last one this member spent, waiting for the next window when needed. */
async function freshCode(member) {
  let step = Math.floor(Date.now() / STEP_MS);
  while (step <= Number(member.lastStep ?? 0)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    step = Math.floor(Date.now() / STEP_MS);
  }
  member.lastStep = step;
  return totpNow(member.totpSecret, new Date(step * STEP_MS));
}

/** Makes the role's member on this stack: sign-up with the mailed code, then an authenticator. Saves as it goes. */
async function makeMember(browser, ctx, vault, file, role) {
  const tag = randomBytes(4).toString('hex');
  const member = {
    role,
    email: STAFF_TEST_MEMBERS[role],
    handle: `staff${role}${tag}`,
    password: `Staff-${role}-${randomBytes(12).toString('base64url')}-Test!`,
    userId: null,
    totpSecret: null,
    lastStep: 0,
  };
  // Saved before the sign-up, so a run that stops half way still holds the only copy of the password.
  vault.staff[role] = member;
  writePrivate(file, vault);
  const context = await browser.newContext();
  try {
    await signUpInBrowser(await context.newPage(), member);
  } finally {
    await context.close();
  }
  const edge = ctx.url('edge');
  const session = await identity(edge, 'auth.login', {
    identifier: member.email,
    password: member.password,
    deviceKey: LOCAL_TEST_DEVICE_KEY,
  });
  member.userId = session.userId;
  const started = await identity(edge, 'totp.enrol', {}, session.accessToken);
  member.totpSecret = started.secret;
  writePrivate(file, vault);
  await identity(edge, 'totp.confirm', { secret: member.totpSecret, code: await freshCode(member) }, session.accessToken);
  member.totpConfirmed = true;
  writePrivate(file, vault);
  return member;
}

/**
 * Signs the TEST staff member of `role` ('support', 'compliance', 'risk' or 'finance') in to the console in this page, making
 * them first if this stack has not yet. `browser` is the test's browser fixture (for the one sign-up). Returns their user id.
 */
export async function staffSignIn(page, browser, role) {
  if (!STAFF_TEST_MEMBERS[role]) throw new Error(`no TEST staff role ${role}: one of ${Object.keys(STAFF_TEST_MEMBERS).join(', ')}`);
  await assertAdminUp();
  const ctx = await makeContext({ log: () => {} });
  const file = path.join(ctx.paths.stateDir, VAULT_NAME);
  const { member, code } = await withLock(file, async () => {
    const vault = readVault(file);
    let held = vault.staff[role];
    if (held && !held.totpConfirmed)
      throw new Error(
        `${file} holds a half-made ${role} member (a run stopped while making it); start the stack fresh before signing staff in`,
      );
    held ??= await makeMember(browser, ctx, vault, file, role);
    const next = await freshCode(held);
    writePrivate(file, vault);
    return { member: held, code: next };
  });
  // The console signs in as the stack's one TEST browser, so identity's new-device check does not stop staff here.
  await page.context().addCookies([localTestAdminDeviceCookie(ADMIN)]);
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel('Email or handle').fill(member.email);
  await page.getByLabel('Password').fill(member.password);
  await page.getByLabel('Authenticator or recovery code').fill(code);
  await page.locator('button[type=submit]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  return { userId: member.userId, email: member.email };
}
