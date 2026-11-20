import path from 'node:path';
import { expect } from './journey.mjs';
import { signIn } from './desk.mjs';
import { nextCode } from './identity-factors.mjs';
import { ROOT, tool } from './stack.mjs';

// What the bank journeys share: the run's person and their authenticator, the stack's two TEST founders at the bank's
// ops and treasury doors, and the bank's switches on the stack. The parts that hold a journey
// file's own state are made per file from it (`bankPerson({ run, J })`, `staffDoors()`).

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** The run's person (made by #1) and their sign-in, with a fresh authenticator code once a step set one up. */
export function bankPerson({ run, J }) {
  function person() {
    const { who } = run.read();
    if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
    return who;
  }
  /** The next authenticator code, once a step has set one up, keeping its step so no code is ever used twice. */
  async function code() {
    const state = run.read();
    if (!state.secret) return undefined;
    const { totp } = await totpLib();
    const next = await nextCode(totp, state.secret, state.step);
    run.write({ step: next.step });
    return next.code;
  }
  /** Signs the person in on the page; once an authenticator is set up, with a fresh code too. */
  async function signInPerson(page) {
    const who = person();
    const totpCode = await code();
    if (!totpCode) return signIn(page, who);
    await page.goto('/login');
    await page.fill('input[name=totp]', totpCode);
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }
  return { person, code, signInPerson };
}

/** The stack's two TEST founders at the bank's doors, signed in once per journey file on first use. */
export function staffDoors() {
  let staff;
  async function founders() {
    staff ??= (async () => {
      const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
      const ctx = await gates.makeContext({ log: () => {} });
      return { gates, ctx, sessions: await gates.approverSessions(ctx) };
    })();
    return staff;
  }
  /**
   * One treasury door of the bank, approved by the stack's two TEST founders as an owner's change would be. The approval
   * is bound to `fields`, the door's canonical strings; `input` is what the door is sent.
   */
  async function treasury(actionType, procedure, input, fields) {
    const { gates, ctx, sessions } = await founders();
    const approval = await gates.twoPerson(ctx, sessions, {
      actionType,
      targetService: 'svc-bank',
      targetId: actionType,
      expectedVersion: '1',
      payloadHash: gates.bankPayloadHash(actionType, fields),
      policyVersion: gates.MARKERS.policyVersion,
    });
    const res = await ctx.edge.mutate('bank', procedure, { ...input, ...approval }, await sessions.a.treasuryToken());
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    return res.json.result.data;
  }
  /** One card-issuer event through the bank's ops door, approved by two founders as the simulator's stand-in requires. */
  const cardEvent = (actionType, procedure, fields) => treasury(actionType, procedure, fields, fields);
  return { founders, treasury, cardEvent };
}

/** The person's spaces, through their own svc-bank session (`bank(who)`, the file's own). */
export function spacesOf(bank) {
  return async function spaces(who) {
    const res = await (await bank(who)).query('spaces.list', { limit: 50 });
    if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    return res.data;
  };
}

/** The person's cards, through their own svc-bank session (`bank()`, the file's own). */
export function cardsOf(bank) {
  return async function cards() {
    const res = await (await bank()).query('cards.list', { limit: 50 });
    expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
    return res.data;
  };
}

/**
 * The bank's step-up rule on the stack (BANK_STEP_UP_MONEY_OUT), `required` or not, by restarting the bank; the file's
 * kept bank sessions (`kept`) are dropped, as the restart ended them.
 */
export function stepUpRuleOf(kept) {
  return function stepUpRule(required) {
    const key = 'LOCAL_STACK_BANK_STEP_UP_MONEY_OUT';
    const before = process.env[key];
    if (required) process.env[key] = 'required';
    else delete process.env[key];
    try {
      tool('local-test-stack.mjs', 'restart', 'bank');
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
    kept.clear();
  };
}

/**
 * The bank restarted with no deposit custody, or back on the stack's svc-pay. "Off" is written to the file's own state
 * (`custody`) before the restart, so a step that fails or a run cancelled while custody is off is put back by the file's
 * hooks (`putCustodyBack`), and cleared only once the bank is connected again.
 */
export function depositCustody(custody) {
  function bankDepositCustody(on) {
    const before = process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
    if (on) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
    else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = 'off';
    if (!on) custody.write({ off: true });
    try {
      tool('local-test-stack.mjs', 'restart', 'bank');
      if (on) custody.reset({});
    } finally {
      if (before === undefined) delete process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY;
      else process.env.LOCAL_STACK_BANK_DEPOSIT_CUSTODY = before;
    }
  }
  const putCustodyBack = () => {
    if (custody.read().off) bankDepositCustody(true);
  };
  return { bankDepositCustody, putCustodyBack };
}

/** The TEST pay-in partner says a payment was paid, through its signed job door, as the partner would. */
export function partnerPayIn(stackCtx) {
  return async function partnerPaid(body) {
    const ctx = await stackCtx();
    const raw = JSON.stringify(body);
    const res = await fetch(`${ctx.url('bank')}/internal/jobs/payin-sim/paid`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
    const answer = await res.json().catch(() => null);
    if (res.status !== 200) throw new Error(`payin-sim/paid refused: ${res.status} ${JSON.stringify(answer).slice(0, 300)}`);
    return answer;
  };
}

/** A `datetime-local` value, in the browser's (and this process's) local time. */
export function local(at) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Closes the open dialog with its own Close button, and it is gone. */
export async function close(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
