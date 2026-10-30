#!/usr/bin/env node
// The local stack's TEST chain: a throwaway anvil on loopback, started with --chain-id 84532 (the app's network id,
// APP_CHAIN_ID) so the Web3 rooms treat it as their network. It is a LOCAL TEST stand-in, not Base Sepolia: it starts
// empty, forks nothing and reaches nothing; every token, pool and balance on it is TEST and anyone may mint them.
//
// svc-protocol never talks to anvil directly. Its PROTOCOL_RPC_URL is the GATE, a TCP pass-through this file owns. A
// journey that asserts the node is unreachable (J-dex-protocol-01) closes the gate and reopens it when it ends: closed,
// nothing listens on the gate port, the same ECONNREFUSED the stack's UNUSED URL gave before this chain existed.
//
// The stack starts it only when an anvil binary is found (LOCAL_STACK_ANVIL_BIN, else `anvil` on PATH). With none,
// svc-protocol keeps PROTOCOL_RPC_URL=UNUSED, `gate` is a no-op and `fund` refuses by name.
//
//   node tooling/scripts/local-test-chain.mjs serve             anvil + gate + control (the stack runs this as `chain`)
//   node tooling/scripts/local-test-chain.mjs status            {"chain":"running"|"absent","gate":...}
//   node tooling/scripts/local-test-chain.mjs gate open|closed  a journey's switch (stack.mjs tool())
//   node tooling/scripts/local-test-chain.mjs fund <address>    TEST ETH for gas + TEST Token A and B (stack.mjs tool())
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localStackState } from './local-test-state.mjs';

const HOST = '127.0.0.1';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOL_DIR = path.join(REPO, 'services', 'svc-protocol');
/** The app's network id (apps/customer/src/features/protocol/wallet/eip1193.ts APP_CHAIN_ID). */
export const TEST_CHAIN_ID = 84532;
export const CHAIN_PORTS = { gate: 14530, anvil: 14531, control: 14532 };
export const GATE_URL = `http://${HOST}:${CHAIN_PORTS.gate}`;
/** What the seed put on the chain (addresses), written by `serve`'s seed step; absent when no chain runs. */
export const chainRecordPath = (state = localStackState()) => path.join(state, 'test-chain.json');

/** The anvil to run: LOCAL_STACK_ANVIL_BIN when set (CI), else `anvil` on PATH, else null (no TEST chain). */
export function anvilBin(env = process.env) {
  if (env.LOCAL_STACK_ANVIL_BIN) return fs.existsSync(env.LOCAL_STACK_ANVIL_BIN) ? env.LOCAL_STACK_ANVIL_BIN : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'anvil');
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Runs services/svc-protocol/scripts/seed-test-chain.ts with the gate as its RPC; returns { status, output }. */
export function runSeedScript(args) {
  const tsx = path.join(PROTOCOL_DIR, 'node_modules', '.bin', 'tsx');
  const r = spawnSync(tsx, [path.join(PROTOCOL_DIR, 'scripts', 'seed-test-chain.ts'), ...args], {
    cwd: PROTOCOL_DIR,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PROTOCOL_RPC_URL: GATE_URL, PROTOCOL_CHAIN_ID: String(TEST_CHAIN_ID) },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim() };
}

async function control(query) {
  try {
    const res = await fetch(`http://${HOST}:${CHAIN_PORTS.control}/${query}`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch {
    return null;
  }
}

/** `{ chain: 'running', gate: 'open'|'closed' }`, or `{ chain: 'absent' }` when this stack runs no TEST chain. */
export async function chainStatus() {
  const answer = await control('');
  return answer ? { chain: 'running', ...answer } : { chain: 'absent' };
}

function serve() {
  const bin = anvilBin();
  if (!bin) throw new Error('no anvil binary (set LOCAL_STACK_ANVIL_BIN or put anvil on PATH)');
  const anvil = spawn(
    bin,
    ['--host', HOST, '--port', String(CHAIN_PORTS.anvil), '--chain-id', String(TEST_CHAIN_ID), '--accounts', '1', '--silent'],
    { stdio: 'inherit' },
  );
  const sockets = new Set();
  let gate = null;
  const open = () =>
    new Promise((resolve, reject) => {
      if (gate) return resolve();
      const server = net.createServer((client) => {
        const upstream = net.connect(CHAIN_PORTS.anvil, HOST);
        sockets.add(client).add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('error', drop).on('close', drop);
        upstream.on('error', drop).on('close', drop);
        client.pipe(upstream).pipe(client);
      });
      server.once('error', reject);
      server.listen(CHAIN_PORTS.gate, HOST, () => {
        gate = server;
        resolve();
      });
    });
  const close = () =>
    new Promise((resolve) => {
      if (!gate) return resolve();
      const server = gate;
      gate = null;
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  http
    .createServer(async (req, res) => {
      const want = new URL(req.url, `http://${HOST}`).searchParams.get('gate');
      if (want === 'open') await open();
      if (want === 'closed') await close();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ gate: gate ? 'open' : 'closed', chainId: TEST_CHAIN_ID, gateUrl: GATE_URL }));
    })
    .listen(CHAIN_PORTS.control, HOST);
  open();
  let stopping = false;
  // Stop anvil and wait for it, so no anvil outlives the chain process (the stack stops this one by pid).
  const stop = () => {
    stopping = true;
    anvil.kill('SIGTERM');
    setTimeout(() => {
      anvil.kill('SIGKILL');
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGTERM', stop).on('SIGINT', stop);
  anvil.on('exit', (code) => {
    if (stopping) process.exit(0);
    console.error(`anvil exited (${code}); the TEST chain is gone`);
    process.exit(1);
  });
}

async function cmdGate(state) {
  if (!['open', 'closed'].includes(state)) throw new Error('usage: gate open|closed');
  const answer = await control(`?gate=${state}`);
  // No TEST chain on this stack: svc-protocol's RPC is UNUSED, which is already "closed".
  console.log(JSON.stringify(answer ?? { chain: 'absent', gate: 'closed' }));
}

async function cmdFund(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) throw new Error('usage: fund <0x address>');
  const status = await chainStatus();
  if (status.chain !== 'running') {
    console.error('local-test-chain.no_chain: this stack runs no TEST chain (no anvil binary), so nothing can be funded');
    process.exit(1);
  }
  if (status.gate !== 'open') {
    console.error('local-test-chain.gate_closed: the TEST chain gate is closed; open it before funding');
    process.exit(1);
  }
  const r = runSeedScript(['fund', address]);
  console.log(r.output);
  if (r.status !== 0) process.exit(1);
}

const runningAsCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runningAsCli) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'serve') serve();
  else if (command === 'status') console.log(JSON.stringify(await chainStatus()));
  else if (command === 'gate') await cmdGate(arg);
  else if (command === 'fund') await cmdFund(arg);
  else {
    console.error('usage: local-test-chain.mjs serve | status | gate open|closed | fund <address>');
    process.exit(2);
  }
}
