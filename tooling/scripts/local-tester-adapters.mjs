#!/usr/bin/env node
/**
 * The tester compose stack's TEST adapters (docker-compose.tester.yml `test-chain`, `test-venue`; J-home-ia-11 #1): the
 * TEST chain and the TEST venue `pnpm local:stack` runs (startTestChain, startTestVenue), each in its own container on the
 * host's loopback, at the ports of the slot LOCAL_STACK_SLOT names. Home's seed funds founder a's TEST wallet on the
 * chain and pays TEST funds into its account at the venue.
 *
 *   node tooling/scripts/local-tester-adapters.mjs chain          anvil + gate (local-test-chain.mjs serve), then the
 *                                                                 seed and the TEST bridge, as the stack starts them
 *   node tooling/scripts/local-tester-adapters.mjs chain-health   exit 0 once the chain answers and its seed is recorded
 *   node tooling/scripts/local-tester-adapters.mjs venue          the TEST venue simulator, taking deposits of the
 *                                                                 chain's TEST USD
 *
 * LOCAL TEST only: each refuses unless APP_ENV is exactly dev or test. Nothing here is real money or a live market.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAIN_PORTS, GATE_URL, STACK_PORTS, chainRecordPath, localStackState } from './local-test-facts.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

/** The TEST chain's id as its gate answers it, or null while nothing answers. */
async function gateChainId() {
  try {
    const res = await fetch(GATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
      signal: AbortSignal.timeout(2_000),
    });
    return (await res.json()).result ?? null;
  } catch {
    return null;
  }
}

/** The TEST USD token the chain's seed recorded, or null before the seed ran. */
export function recordedUsdToken(stateDir, read = (file) => fs.readFileSync(file, 'utf8')) {
  try {
    const address = JSON.parse(read(chainRecordPath(stateDir))).tokens?.USD?.address;
    return /^0x[0-9a-fA-F]{40}$/.test(address ?? '') ? address : null;
  } catch {
    return null;
  }
}

async function chain(stateDir) {
  const chainModule = await import('./local-test-chain.mjs');
  const { TEST_CHAIN_ID, installTestBridge, runSeedScript } = chainModule;
  fs.rmSync(chainRecordPath(stateDir), { force: true });
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'local-test-chain.mjs'), 'serve'], { stdio: 'inherit', env: process.env });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  const want = `0x${Number(TEST_CHAIN_ID).toString(16)}`;
  for (let i = 0; (await gateChainId()) !== want; i++) {
    if (i >= 120) {
      console.error(`refusing: the TEST chain never answered chain id ${want} on ${GATE_URL}`);
      child.kill('SIGTERM');
      return 1;
    }
    await sleep(500);
  }
  await installTestBridge();
  const seeded = runSeedScript(['seed', chainRecordPath(stateDir)]);
  console.log(`chain: ${seeded.output.split('\n').pop()}`);
  if (seeded.status !== 0) {
    console.error(seeded.output);
    child.kill('SIGTERM');
    return 1;
  }
  return exited;
}

async function venue(stateDir) {
  const { hlSource, serveTestVenue, testVenueChainId, testVenueId, testVenueKind } = await import('./local-test-venue.mjs');
  let usdToken;
  for (let i = 0; !(usdToken = recordedUsdToken(stateDir)); i++) {
    if (i >= 600) {
      console.error(`refusing: the TEST chain recorded no TEST USD in ${chainRecordPath(stateDir)}`);
      return 1;
    }
    await sleep(500);
  }
  await serveTestVenue({
    host: HOST,
    port: STACK_PORTS['test-venue'],
    appEnv: process.env.APP_ENV,
    chainId: testVenueChainId(process.env.TEST_VENUE_CHAIN_ID),
    rpcUrl: `http://${HOST}:${CHAIN_PORTS.anvil}`,
    depositToken: usdToken,
    id: testVenueId(process.env.TEST_VENUE_ID),
    kind: testVenueKind(process.env.TEST_VENUE_KIND),
    hl: hlSource(process.env),
  });
  return null;
}

async function main([command], env = process.env) {
  if (env.APP_ENV !== 'dev' && env.APP_ENV !== 'test') {
    console.error(
      `refusing [seed.app_env_not_local]: APP_ENV is ${env.APP_ENV ? `"${env.APP_ENV}"` : 'not set'}; TEST adapters run on dev or test only`,
    );
    return 2;
  }
  const stateDir = localStackState();
  if (command === 'chain') return chain(stateDir);
  if (command === 'chain-health') return recordedUsdToken(stateDir) && (await gateChainId()) ? 0 : 1;
  if (command === 'venue') return venue(stateDir);
  console.error('usage: local-tester-adapters.mjs chain | chain-health | venue');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((code) => {
    if (code !== null) process.exit(code);
  });
