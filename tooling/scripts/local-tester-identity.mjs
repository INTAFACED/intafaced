#!/usr/bin/env node
/**
 * svc-identity on the tester compose stack (docker-compose.tester.yml, J-home-ia-11 #1): starts identity with the local
 * test founder pair from the vault in LOCAL_STACK_STATE (founderIdentityEnv: the invites, and once both founders are
 * enrolled, their two user ids), and starts it again whenever those change. That is the restart `pnpm local:stack`
 * makes (planFounderIdentityRestart), which a container cannot ask compose for. After each start, once identity answers
 * its health check, it writes the pin stamp (`run/identity-founder-pin.json`) so the founder seed knows what identity
 * runs with.
 *
 *   APP_ENV=dev LOCAL_STACK_STATE=<dir> node tooling/scripts/local-tester-identity.mjs services/svc-identity/dist/index.js
 *
 * LOCAL TEST only: it refuses unless APP_ENV is exactly dev or test, and it never sets a founder value the vault does not
 * hold. Identity's own exit ends this process with the same code, so compose's restart policy still applies.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FOUNDER_VAULT_NAME, founderIdentityEnv, writeFounderPinStamp } from './local-test-founders.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The founder env the vault in `stateDir` gives identity now; {} with no vault or an unreadable one. */
export function vaultFounderEnv(stateDir, read = (file) => fs.readFileSync(file, 'utf8')) {
  try {
    return founderIdentityEnv(JSON.parse(read(path.join(stateDir, FOUNDER_VAULT_NAME))));
  } catch {
    return {};
  }
}

const sameEnv = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

async function healthy(port, until) {
  while (Date.now() < until) {
    const status = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      .then((res) => res.status)
      .catch(() => 0);
    if (status === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main(argv, env = process.env) {
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') {
    console.error(
      `refusing [seed.app_env_not_local]: APP_ENV is ${env.APP_ENV ? `"${env.APP_ENV}"` : 'not set'}; this runs on dev or test only`,
    );
    return 2;
  }
  const stateDir = env.LOCAL_STACK_STATE;
  const [entry] = argv;
  if (!stateDir || !path.isAbsolute(stateDir) || !entry) {
    console.error('usage: LOCAL_STACK_STATE=<absolute dir> local-tester-identity.mjs <identity entry>');
    return 2;
  }
  let pinned = vaultFounderEnv(stateDir);
  let child;
  let restarting = false;
  let stopping = false;
  const start = () => {
    const runWith = { ...env, ...pinned };
    child = spawn(process.execPath, [path.resolve(REPO, entry)], { env: runWith, stdio: 'inherit' });
    const started = child;
    void healthy(env.HTTP_PORT, Date.now() + 120_000).then((up) => {
      if (up && child === started) writeFounderPinStamp(stateDir, runWith);
    });
    return new Promise((resolve) => started.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
  };
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      stopping = true;
      child?.kill(signal);
    });
  const watch = setInterval(() => {
    const next = vaultFounderEnv(stateDir);
    if (stopping || restarting || sameEnv(next, pinned)) return;
    console.log('local-tester-identity: the founder pair in the vault changed; starting identity again with it');
    pinned = next;
    restarting = true;
    child.kill('SIGTERM');
  }, 1_000);
  for (;;) {
    const code = await start();
    if (restarting && !stopping) {
      restarting = false;
      continue;
    }
    clearInterval(watch);
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((code) => process.exit(code));
