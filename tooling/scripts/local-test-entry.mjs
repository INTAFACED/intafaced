#!/usr/bin/env node
/**
 * How a tester signs in to a local test build as a LOCAL TEST founder (J-home-ia-11 #2), with no injected cookie or
 * device: the steps the customer sign-in page's "Tester build" panel names.
 *
 *   node tooling/scripts/local-test-entry.mjs code a|b     a one-time sign-in code for founder a or b
 *   node tooling/scripts/local-test-entry.mjs device a|b   the device code identity mailed to that founder for a new browser
 *
 * The handle and password are in the stack's founders.json. Signing in on a browser identity has not seen asks for a
 * device code, which identity mails only to a confirmed address, so `code` first confirms the founder's address once
 * through identity's own doors (it asks for the link and opens what the stack's LOCAL-TEST outbox received), as a person
 * would. `device` reads the newest unexpired device code from that outbox. Both refuse anything but the active local
 * test stack (makeContext in local-test-gates.mjs) and print no password or second-factor secret.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOUNDER_VAULT_NAME } from './local-test-founders.mjs';
import { approverSessions, founderSignIns, founderTotp, makeContext } from './local-test-gates.mjs';
import { readLatestEmailConfirmToken } from './local-test-state.mjs';

/** The stack identity's LOCAL-TEST mail file (tooling/scripts/local-stack-services/identity.mjs). */
export const OUTBOX_NAME = 'email-outbox.log';
const CONFIRM_WAIT_MS = 20_000;

/**
 * The LOCAL-TEST new-device-code lines to `email` in `text` (services/svc-identity/src/auth/local-mail.ts), oldest first,
 * as { expires, code }. The address is matched as local-test-state.mjs matches a confirm link: trimmed, any case.
 */
export function deviceCodesMailedTo(text, email) {
  const want = String(email ?? '')
    .trim()
    .toLowerCase();
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST ') && line.includes(' purpose=new-device-code '))
    .filter((line) => /(?:^|\s)email=(\S+)/.exec(line)?.[1].toLowerCase() === want)
    .map((line) => ({
      expires: /(?:^|\s)expires=(\S+)/.exec(line)?.[1] ?? null,
      code: /(?:^|\s)code=(\d{6})(?:\s|$)/.exec(line)?.[1] ?? null,
    }));
}

/** The newest device code in `text` for `email` that has not expired at `now`, or null. */
export function waitingDeviceCode(text, email, now = new Date()) {
  const live = deviceCodesMailedTo(text, email).filter((m) => m.code && m.expires && Date.parse(m.expires) > now.getTime());
  return live.at(-1) ?? null;
}

const outbox = (ctx) => {
  const file = path.join(ctx.paths.stateDir, OUTBOX_NAME);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

function founderOf(ctx, key) {
  if (key !== 'a' && key !== 'b') throw new Error('usage: local-test-entry.mjs code|device a|b');
  const file = path.join(ctx.paths.stateDir, FOUNDER_VAULT_NAME);
  const vault = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const founder = founderSignIns(vault).find((f) => f.key === key);
  if (!founder) throw new Error(`the founder pair in ${FOUNDER_VAULT_NAME} is not enrolled yet: start the local test stack first`);
  return founder;
}

/** Confirms founder `key`'s address through identity's own doors, once. Returns 'confirmed' or 'already confirmed'. */
export async function confirmFounderAddress(ctx, key) {
  const founder = founderOf(ctx, key);
  const token = (await approverSessions(ctx))[key].token;
  const me = await ctx.edge.query('identity', 'me', undefined, token);
  if (me.status !== 200) throw new Error(`identity me refused (${me.status})`);
  const verified = async () => (await ctx.edge.query('identity', 'me', undefined, token)).json?.result?.data?.emailVerified === true;
  if (me.json?.result?.data?.emailVerified === true) return 'already confirmed';
  const before = readLatestEmailConfirmToken(outbox(ctx), founder.email);
  const asked = await ctx.edge.mutate('identity', 'auth.requestEmailConfirmation', {}, token);
  if (asked.status !== 200) throw new Error(`identity refused the confirmation email (${asked.status}): ${asked.text.slice(0, 300)}`);
  const until = Date.now() + CONFIRM_WAIT_MS;
  let confirmToken;
  while ((confirmToken = readLatestEmailConfirmToken(outbox(ctx), founder.email)) === before) {
    // Identity answers without mailing an address that is already confirmed, so another run may have got there first.
    if (Date.now() > until) {
      if (await verified()) return 'already confirmed';
      throw new Error(`no confirmation email reached ${OUTBOX_NAME} for ${founder.handle}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const confirmed = await ctx.edge.mutate('identity', 'auth.confirmEmail', { token: confirmToken });
  if (confirmed.status !== 200) throw new Error(`identity refused the confirmation (${confirmed.status}): ${confirmed.text.slice(0, 300)}`);
  return 'confirmed';
}

async function main() {
  const [cmd, key] = process.argv.slice(2);
  if ((cmd !== 'code' && cmd !== 'device') || (key !== 'a' && key !== 'b')) {
    console.error('usage: node tooling/scripts/local-test-entry.mjs code|device a|b');
    process.exit(2);
  }
  const ctx = await makeContext({ log: () => {}, shareSessions: true });
  const founder = founderOf(ctx, key);
  if (cmd === 'code') {
    const address = await confirmFounderAddress(ctx, key);
    console.log(`LOCAL TEST founder ${founder.handle}: address ${address}`);
    // Last, after the sign-ins above, so no local tool spends this step before the tester does.
    console.log(`one-time code: ${await founderTotp(ctx, key, founder.totpSecret)} (about 30 seconds; a used code never works twice)`);
  } else {
    const waiting = waitingDeviceCode(outbox(ctx), founder.email);
    if (!waiting) {
      console.error(`no device code is waiting for ${founder.handle}: sign in on the new browser first, then run this again`);
      process.exit(1);
    }
    console.log(`device code for ${founder.handle}: ${waiting.code} (until ${waiting.expires})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`refusing: ${err.message ?? err}`);
    process.exit(1);
  });
}
