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
//   node tooling/scripts/local-test-chain.mjs gate open|closed second   the same for the second network's gate alone
//   node tooling/scripts/local-test-chain.mjs fund <address>    TEST ETH for gas + TEST Token A and B (stack.mjs tool())
//   node tooling/scripts/local-test-chain.mjs fund <address> stable   TEST USD only and no TEST ETH (J-dex-protocol-02 #11)
//   node tooling/scripts/local-test-chain.mjs fund <address> spam     TEST Airdrop sent unasked (J-dex-protocol-04 #7)
//   node tooling/scripts/local-test-chain.mjs fund <address> venue    TEST ETH for gas + TEST USD to deposit (J-wallet-09 #3)
//   node tooling/scripts/local-test-chain.mjs fund <address> plain    TEST Token C, the token with no permit (J-dex-protocol-03)
//
// `serve` also runs, on the same port, the Navigator's TEST signer at /navigator (J-agents-19 #4): one SmartAccount
// executeWithSession call, sent from the Navigator's TEST session key address, impersonated on this anvil.
// `serve` also runs the TEST network-fee relayer (RC-dex-protocol-02) on RELAY_URL: a stand-in for the relay a person's
// signed fee-token swap is handed to. It takes one call for the seeded FeeTokenRelay's swap(), sends it from the seeded
// TEST relayer (an impersonated address on this anvil, holding TEST ETH), and answers the hash. It signs nothing itself
// and sends nothing else: the relay contract checks the person's signature and prices the fee.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN_HOST, CHAIN_PORTS, GATE_URL, TEST_CHAIN_ID, chainRecordPath } from './local-test-facts.mjs';

const HOST = CHAIN_HOST;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOL_DIR = path.join(REPO, 'services', 'svc-protocol');
// The chain's id, ports, gate and record file live in local-test-facts.mjs, so the journeys read them without this script.
export { CHAIN_PORTS, GATE_URL, TEST_CHAIN_ID, chainRecordPath };
/** The TEST network-fee relayer's submit URL (svc-protocol's PROTOCOL_FEE_RELAY_URL on the stack). */
export const RELAY_URL = `http://${HOST}:${CHAIN_PORTS.relay}/relay`;
/**
 * The Navigator's TEST signer (J-agents-19 #4): POST {chainId, from, to, data} here sends one SmartAccount
 * executeWithSession call from the Navigator's TEST session key address, impersonated on this anvil. It is the stand-in
 * for the signer a production Navigator would hold its session key in; svc-agents holds no key.
 */
export const NAVIGATOR_SIGNER_URL = `http://${HOST}:${CHAIN_PORTS.relay}/navigator`;
/**
 * INTAFACED's TEST receiving address for Academy course payments (J-academy-07): a buyer's TEST wallet pays the course
 * price in TEST USD here. Nobody holds a key for it; on this anvil the TEST refund signer below sends from it by
 * impersonation. TEST only: production's receiving address is the owner's ACADEMY_PAYMENT_RECEIVER.
 */
export const ACADEMY_TEST_RECEIVER = '0x7e57ac4d00000000000000000000000000000007';
/**
 * The TEST refund signer (J-academy-07 #7): POST {key, chainId, token, to, amount} here sends one TEST USD transfer of
 * `amount` (smallest unit) from ACADEMY_TEST_RECEIVER to `to`, and answers {hash}. The same key answers the same hash and
 * sends nothing more, as the owner's real signer must. It is the stand-in for the signer that holds INTAFACED's key;
 * svc-academy holds none.
 */
export const ACADEMY_REFUND_SIGNER_URL = `http://${HOST}:${CHAIN_PORTS.relay}/academy-refund`;
/** SmartAccount.executeWithSession's selector: the one call a session key can make, and the only call this signer sends. */
export const EXECUTE_WITH_SESSION_SELECTOR = '0xbd210fed';
/** FeeTokenRelay.swap's selector: the one call the TEST relayer sends. */
export const RELAY_SWAP_SELECTOR = '0xff292559';
/**
 * A second LOCAL TEST network (chain id 31337, "Local test chain"), so the explorer's search has two networks to look a
 * hash up on (J-dex-protocol-09 #10). Nothing is seeded on it; it has its own gate, which a journey may shut alone.
 */
export const SECOND_CHAIN_ID = 31337;
export const SECOND_CHAIN_PORTS = { gate: CHAIN_PORTS.secondGate, anvil: CHAIN_PORTS.secondAnvil };
export const SECOND_GATE_URL = `http://${HOST}:${SECOND_CHAIN_PORTS.gate}`;

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

/** A TCP pass-through on `gatePort` to the anvil on `anvilPort`: open, it forwards; closed, nothing listens there. */
function makeGate(gatePort, anvilPort) {
  const sockets = new Set();
  let server = null;
  return {
    isOpen: () => server !== null,
    open: () =>
      new Promise((resolve, reject) => {
        if (server) return resolve();
        const next = net.createServer((client) => {
          const upstream = net.connect(anvilPort, HOST);
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
        next.once('error', reject);
        next.listen(gatePort, HOST, () => {
          server = next;
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (!server) return resolve();
        const closing = server;
        server = null;
        for (const s of sockets) s.destroy();
        closing.close(() => resolve());
      }),
  };
}

function serve() {
  const bin = anvilBin();
  if (!bin) throw new Error('no anvil binary (set LOCAL_STACK_ANVIL_BIN or put anvil on PATH)');
  const anvils = [
    spawn(bin, ['--host', HOST, '--port', String(CHAIN_PORTS.anvil), '--chain-id', String(TEST_CHAIN_ID), '--accounts', '1', '--silent'], {
      stdio: 'inherit',
    }),
    spawn(
      bin,
      ['--host', HOST, '--port', String(SECOND_CHAIN_PORTS.anvil), '--chain-id', String(SECOND_CHAIN_ID), '--accounts', '1', '--silent'],
      { stdio: 'inherit' },
    ),
  ];
  const gate = makeGate(CHAIN_PORTS.gate, CHAIN_PORTS.anvil);
  const second = makeGate(SECOND_CHAIN_PORTS.gate, SECOND_CHAIN_PORTS.anvil);
  http
    .createServer(async (req, res) => {
      const params = new URL(req.url, `http://${HOST}`).searchParams;
      const target = params.get('network') === 'second' ? second : gate;
      const want = params.get('gate');
      if (want === 'open') await target.open();
      if (want === 'closed') await target.close();
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          gate: gate.isOpen() ? 'open' : 'closed',
          chainId: TEST_CHAIN_ID,
          gateUrl: GATE_URL,
          second: { gate: second.isOpen() ? 'open' : 'closed', chainId: SECOND_CHAIN_ID, gateUrl: SECOND_GATE_URL },
        }),
      );
    })
    .listen(CHAIN_PORTS.control, HOST);
  http
    .createServer((req, res) => {
      const pathname = new URL(req.url, `http://${HOST}`).pathname;
      void (pathname === '/navigator'
        ? navigatorSign(req, res)
        : pathname === '/academy-refund'
          ? academyRefund(req, res)
          : relay(req, res));
    })
    .listen(CHAIN_PORTS.relay, HOST);
  // A gate that cannot listen (its port taken after the stack's check) stops the chains with its error, never unhandled.
  Promise.all([gate.open(), second.open()]).catch((err) => {
    console.error(`a TEST chain gate could not open: ${err.message}`);
    stop(1);
  });
  let stopping = false;
  let exited = 0;
  let stopCode = 0;
  // Stop both anvils and wait for them, so no anvil outlives the chain process (the stack stops this one by pid).
  const stop = (code = 0) => {
    stopping = true;
    stopCode = typeof code === 'number' ? code : 0;
    for (const anvil of anvils) anvil.kill('SIGTERM');
    setTimeout(() => {
      for (const anvil of anvils) anvil.kill('SIGKILL');
      process.exit(stopCode);
    }, 5000).unref();
  };
  process.on('SIGTERM', stop).on('SIGINT', stop);
  for (const anvil of anvils)
    anvil.on('exit', (code) => {
      // While stopping, the process waits for every anvil (or the SIGKILL fallback), so none outlives it.
      if (stopping) {
        if (++exited === anvils.length) process.exit(stopCode);
        return;
      }
      console.error(`anvil exited (${code}); the TEST chains are gone`);
      for (const other of anvils) other.kill('SIGTERM');
      process.exit(1);
    });
}

/** One JSON-RPC call to this stack's anvil, straight to its port (the relayer has its own connection, not the gate). */
async function anvilRpc(method, params) {
  const res = await fetch(`http://${HOST}:${CHAIN_PORTS.anvil}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = await res.json();
  if (answer.error) throw new Error(answer.error.message ?? JSON.stringify(answer.error));
  return answer.result;
}

const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * POST /relay {to, data, gas, maxFeePerGas, maxPriorityFeePerGas} (hex): sent from the seeded TEST relayer when `to` is
 * the seeded fee relay and `data` calls its swap(); anything else is refused by name. Answers {hash} or {error}.
 */
async function relay(req, res) {
  const answer = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || new URL(req.url, `http://${HOST}`).pathname !== '/relay')
    return answer(404, { error: 'relay.not_found: POST /relay only' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) return answer(413, { error: 'relay.too_large' });
  }
  let call;
  try {
    call = JSON.parse(raw);
  } catch {
    return answer(400, { error: 'relay.bad_json' });
  }
  const record = fs.existsSync(chainRecordPath()) ? JSON.parse(fs.readFileSync(chainRecordPath(), 'utf8')) : null;
  if (!record?.feeRelay || !record?.feeRelayer) return answer(503, { error: 'relay.unseeded: the TEST chain has no fee relay yet' });
  if (typeof call?.to !== 'string' || call.to.toLowerCase() !== record.feeRelay.toLowerCase())
    return answer(400, { error: 'relay.wrong_target: only the seeded fee relay is called' });
  if (typeof call.data !== 'string' || !HEX.test(call.data) || !call.data.toLowerCase().startsWith(RELAY_SWAP_SELECTOR))
    return answer(400, { error: 'relay.wrong_call: only the fee relay swap() is sent' });
  for (const field of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas'])
    if (typeof call[field] !== 'string' || !HEX.test(call[field])) return answer(400, { error: `relay.bad_${field}` });
  try {
    const hash = await anvilRpc('eth_sendTransaction', [
      {
        from: record.feeRelayer,
        to: record.feeRelay,
        data: call.data,
        gas: call.gas,
        maxFeePerGas: call.maxFeePerGas,
        maxPriorityFeePerGas: call.maxPriorityFeePerGas,
      },
    ]);
    return answer(200, { hash, relayer: record.feeRelayer });
  } catch (err) {
    return answer(502, { error: `relay.send_failed: ${err.message}` });
  }
}

/** The Navigator's TEST session key address, from the stack's labelled TEST owner values. */
function navigatorSignerAddress() {
  const file = path.join(REPO, 'tooling', 'profiles', 'test-owner-values', 'agents.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).values.AGENTS_NAVIGATOR_ONCHAIN_SIGNER.value.toLowerCase();
}

/**
 * POST /navigator {chainId, from, to, data} (hex): sent from the Navigator's TEST session key address when `from` is that
 * address and `data` calls a smart account's executeWithSession; anything else is refused by name. The account contract
 * itself checks that the key is live and that the call is in its scope, cap and expiry; this signer checks nothing more
 * and signs nothing. Answers {hash} or {error}.
 */
async function navigatorSign(req, res) {
  const answer = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return answer(404, { error: 'navigator.not_found: POST /navigator only' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) return answer(413, { error: 'navigator.too_large' });
  }
  let call;
  try {
    call = JSON.parse(raw);
  } catch {
    return answer(400, { error: 'navigator.bad_json' });
  }
  if (call?.chainId !== TEST_CHAIN_ID) return answer(400, { error: 'navigator.wrong_chain: the TEST chain only' });
  const signer = navigatorSignerAddress();
  if (typeof call.from !== 'string' || call.from.toLowerCase() !== signer)
    return answer(400, { error: "navigator.wrong_signer: only the Navigator's TEST session key sends" });
  if (typeof call.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(call.to)) return answer(400, { error: 'navigator.bad_to' });
  if (typeof call.data !== 'string' || !HEX.test(call.data) || !call.data.toLowerCase().startsWith(EXECUTE_WITH_SESSION_SELECTOR))
    return answer(400, { error: 'navigator.wrong_call: only a smart account executeWithSession is sent' });
  try {
    await anvilRpc('anvil_impersonateAccount', [signer]);
    // TEST ETH for gas only; the call itself carries no value.
    await anvilRpc('anvil_setBalance', [signer, '0x56bc75e2d63100000']);
    const hash = await anvilRpc('eth_sendTransaction', [{ from: signer, to: call.to, data: call.data, value: '0x0' }]);
    return answer(200, { hash });
  } catch (err) {
    return answer(502, { error: `navigator.send_failed: ${err.message}` });
  }
}

/** The refunds the TEST refund signer has sent, by key, so the same key never sends twice (kept for this chain's life). */
const academyRefunds = new Map();

/**
 * POST /academy-refund {key, chainId, token, to, amount}: one TEST USD transfer from ACADEMY_TEST_RECEIVER to `to`. Only
 * the seeded TEST USD token on the TEST chain, a key that names an Academy refund, and a whole positive amount. A key
 * already sent answers its first hash and sends nothing. Answers {hash} or {error}.
 */
async function academyRefund(req, res) {
  const answer = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return answer(404, { error: 'refund.not_found: POST /academy-refund only' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8_000) return answer(413, { error: 'refund.too_large' });
  }
  let call;
  try {
    call = JSON.parse(raw);
  } catch {
    return answer(400, { error: 'refund.bad_json' });
  }
  if (call?.chainId !== TEST_CHAIN_ID) return answer(400, { error: 'refund.wrong_chain: the TEST chain only' });
  if (typeof call.key !== 'string' || !/^academy:refund:[^\s]{1,190}$/.test(call.key)) return answer(400, { error: 'refund.bad_key' });
  const record = fs.existsSync(chainRecordPath()) ? JSON.parse(fs.readFileSync(chainRecordPath(), 'utf8')) : null;
  const usd = record?.tokens?.USD?.address?.toLowerCase();
  if (!usd || typeof call.token !== 'string' || call.token.toLowerCase() !== usd)
    return answer(400, { error: 'refund.wrong_token: the seeded TEST USD only' });
  if (typeof call.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(call.to)) return answer(400, { error: 'refund.bad_to' });
  if (typeof call.amount !== 'string' || !/^[1-9][0-9]{0,30}$/.test(call.amount)) return answer(400, { error: 'refund.bad_amount' });
  const sent = academyRefunds.get(call.key);
  if (sent) return answer(200, { hash: sent });
  const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0xa9059cbb${pad(call.to)}${pad(BigInt(call.amount).toString(16))}`;
  try {
    await anvilRpc('anvil_impersonateAccount', [ACADEMY_TEST_RECEIVER]);
    // TEST ETH for gas only; the call itself carries no value.
    await anvilRpc('anvil_setBalance', [ACADEMY_TEST_RECEIVER, '0x56bc75e2d63100000']);
    const hash = await anvilRpc('eth_sendTransaction', [{ from: ACADEMY_TEST_RECEIVER, to: usd, data, value: '0x0' }]);
    academyRefunds.set(call.key, hash);
    return answer(200, { hash });
  } catch (err) {
    return answer(502, { error: `refund.send_failed: ${err.message}` });
  }
}

async function cmdGate(state, network) {
  if (!['open', 'closed'].includes(state) || ![undefined, 'second'].includes(network)) throw new Error('usage: gate open|closed [second]');
  const answer = await control(`?gate=${state}${network ? `&network=${network}` : ''}`);
  // No TEST chain on this stack: svc-protocol's RPC is UNUSED, which is already "closed".
  console.log(JSON.stringify(answer ?? { chain: 'absent', gate: 'closed' }));
}

async function cmdFund(address, kind) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '') || ![undefined, 'stable', 'spam', 'venue', 'plain'].includes(kind))
    throw new Error('usage: fund <0x address> [stable|spam|venue|plain]');
  const status = await chainStatus();
  if (status.chain !== 'running') {
    console.error('local-test-chain.no_chain: this stack runs no TEST chain (no anvil binary), so nothing can be funded');
    process.exit(1);
  }
  if (status.gate !== 'open') {
    console.error('local-test-chain.gate_closed: the TEST chain gate is closed; open it before funding');
    process.exit(1);
  }
  const r = runSeedScript(['fund', address, ...(kind ? [kind] : [])]);
  console.log(r.output);
  if (r.status !== 0) process.exit(1);
}

const runningAsCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runningAsCli) {
  const [command, arg, extra] = process.argv.slice(2);
  if (command === 'serve') serve();
  else if (command === 'status') console.log(JSON.stringify(await chainStatus()));
  else if (command === 'gate') await cmdGate(arg, extra);
  else if (command === 'fund') await cmdFund(arg, extra);
  else {
    console.error('usage: local-test-chain.mjs serve | status | gate open|closed [second] | fund <address> [stable|spam|venue|plain]');
    process.exit(2);
  }
}
