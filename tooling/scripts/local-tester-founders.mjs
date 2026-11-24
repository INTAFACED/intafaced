#!/usr/bin/env node
/**
 * The tester compose stack's founder step (`local-tester-founders.mjs enrol`, the seed service's first step,
 * docker-compose.apps.yml `seed`): what `pnpm local:stack` does for its founder pair (ensureLocalTestFounders), on a
 * compose stack. It enrols local_test_founder_a and local_test_founder_b through the stack's own edge, waits until
 * identity runs with their two user ids (local-tester-identity.mjs starts it again when the vault changes), then confirms
 * each founder's email address from the stack's LOCAL TEST outbox, as their owner would.
 *
 *   LOCAL_TEST=1 APP_ENV=test LOCAL_STACK_STATE=<dir> node tooling/scripts/local-tester-founders.mjs enrol [--state <dir>]
 *
 * WHAT IT REFUSES. Anything but the compose marker in the state folder (a `pnpm local:stack` stack enrols its own pair),
 * a stack whose database does not hold that marker's stack id (assertActiveLocalStack), and every guard of the founder
 * seed itself (assertLocalTestFounderTarget). The vault stays in the state folder, mode 600; no secret is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GuardError,
  confirmFounderEmails,
  enrolTestStackFounders,
  ensureFounderVaultDraft,
  founderIdentityEnv,
  foundersEnrolled,
  planFounderIdentityRestart,
  readFounderPinStamp,
} from './local-test-founders.mjs';
import { COMPOSE_RUNTIME, assertActiveLocalStack } from './local-test-state.mjs';
import { LOCAL_TEST_DEVICE_KEY } from './local-test-device.mjs';

const readVault = (vaultPath) => JSON.parse(fs.readFileSync(vaultPath, 'utf8'));

/** Waits until identity's pin stamp says it runs with what `ready(stamp)` asks; refuses by name after `ms`. */
async function waitForIdentity(stateDir, ready, what, { ms = 180_000, sleep = (t) => new Promise((r) => setTimeout(r, t)) } = {}) {
  const until = Date.now() + ms;
  while (!ready(readFounderPinStamp(stateDir))) {
    if (Date.now() >= until) throw new GuardError(`refusing: identity did not start with ${what} within ${ms / 1000} s`);
    await sleep(1_000);
  }
}

export async function enrol({ stateDir, log = console.log }) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir))
    throw new GuardError('refusing: the state folder must be an absolute path');
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(stateDir, 'LOCAL-TEST-STACK.json'), 'utf8'));
  } catch {
    throw new GuardError(`refusing: no stack marker in ${stateDir}; run local-test-compose-env.mjs first`);
  }
  if (marker?.runtime !== COMPOSE_RUNTIME)
    throw new GuardError('refusing: this is the tester compose stack step; `pnpm local:stack` enrols its own founder pair');
  assertActiveLocalStack({ stateDir, services: ['edge', 'identity'] });
  const edgeUrl = `http://127.0.0.1:${marker.ports.edge}`;
  const { vaultPath } = ensureFounderVaultDraft({ stateDir, marker, edgeUrl, log });
  const draft = readVault(vaultPath);
  await waitForIdentity(
    stateDir,
    (stamp) => !planFounderIdentityRestart({ enrolled: foundersEnrolled(draft), stamp, vault: draft }).restartBeforeEnrol,
    "the founder pair's invites",
  );
  if (!foundersEnrolled(draft)) {
    log('founders: enrolling local_test_founder_a and local_test_founder_b on this stack');
    await enrolTestStackFounders({ stateDir, marker, edgeUrl, log });
  }
  const vault = readVault(vaultPath);
  if (!foundersEnrolled(vault)) throw new GuardError('refusing: the local test founder pair did not enrol');
  await waitForIdentity(
    stateDir,
    (stamp) => !planFounderIdentityRestart({ enrolled: true, stamp, vault }).restartToPin,
    "the founder pair's user ids",
  );
  const { makeContext, founderTotp } = await import('./local-test-gates.mjs');
  let ctx;
  await confirmFounderEmails({
    stateDir,
    marker,
    edgeUrl,
    log,
    signIn: async (f) => {
      ctx ??= await makeContext({ log: () => {} });
      const login = await ctx.edge.mutate('identity', 'auth.login', {
        identifier: f.handle,
        password: f.password,
        totpCode: await founderTotp(ctx, f.key, f.totpSecret),
        deviceKey: LOCAL_TEST_DEVICE_KEY,
      });
      const token = login.json?.result?.data?.accessToken;
      if (typeof token !== 'string') throw new GuardError(`founder ${f.key} could not sign in to confirm their email (${login.status})`);
      return token;
    },
  });
  const pinned = founderIdentityEnv(readVault(vaultPath));
  log(
    `founders: local_test_founder_a and local_test_founder_b enrolled, pinned in identity (${pinned.IDENTITY_FOUNDER_NITRO_USER_ID}, ${pinned.IDENTITY_FOUNDER_PHANTOM_USER_ID}) and their email addresses confirmed`,
  );
}

async function main(argv, env = process.env) {
  const args = [...argv];
  const at = args.indexOf('--state');
  const stateDir = at >= 0 ? args.splice(at, 2)[1] : env.LOCAL_STACK_STATE;
  if (env.LOCAL_TEST !== '1') throw new GuardError('refusing: set LOCAL_TEST=1 to confirm this is a local test stack');
  if (env.NODE_ENV === 'production') throw new GuardError('refusing: NODE_ENV is "production"');
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') throw new GuardError('refusing: APP_ENV must be exactly "dev" or "test"');
  if (args.length !== 1 || args[0] !== 'enrol') throw new GuardError('usage: local-tester-founders.mjs enrol [--state <dir>]');
  await enrol({ stateDir });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(err instanceof GuardError ? 2 : 1);
    },
  );
