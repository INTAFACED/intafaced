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
//   node tooling/scripts/local-test-chain.mjs fund <address> bridge   TEST ETH on both chains + 100 TEST USDC of the TEST
//                                                                        bridge token (J-dex-protocol-05 #6)
//   node tooling/scripts/local-test-chain.mjs fund <address> positions  a TEST lending collateral deposit and a TEST venue
//                                                                        deposit, made as that address (J-dex-protocol-06 #4)
//
// `serve` also runs, on the same port, the Navigator's TEST signer at /navigator (J-agents-19 #4): one SmartAccount
// executeWithSession call, sent from the Navigator's TEST session key address, impersonated on this anvil.
// `serve` also runs the TEST network-fee relayer (RC-dex-protocol-02) on RELAY_URL: a stand-in for the relay a person's
// signed fee-token swap is handed to. It takes one call for the seeded FeeTokenRelay's swap(), sends it from the seeded
// TEST relayer (an impersonated address on this anvil, holding TEST ETH), and answers the hash. It signs nothing itself
// and sends nothing else: the relay contract checks the person's signature and prices the fee.
// `serve` also runs the TEST pay-in partner's delivery at /payin-deliver (J-dex-protocol-05 #4): a stand-in for the
// partner that delivers a purchase to the buyer's own wallet. svc-bank's pay-in stand-in calls it once the payer
// approved; it sends TEST USD (the TEST chain's USDC) from the TEST partner's own address, impersonated on this anvil and
// minted only what it delivers, and answers the mined transfer's hash.
// `serve` also runs the TEST bridge attester at /bridge-attestation (D-bridge-chain-03, J-dex-protocol-05 #6): a stand-in
// for a bridge provider's attestation service. For a burn of the TEST bridge token (TestBridgeToken, installed at
// BRIDGE_TOKEN on both TEST chains by `installTestBridge`) with BRIDGE_CONFIRMATIONS blocks on top, it answers the
// destination chain's mint attestation, signed by the node's own unlocked dev account (anvil's public mnemonic); before
// that it answers pending. It sends nothing.
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
/** The TEST pay-in partner's delivery (svc-bank's BANK_PAYIN_SIM_DELIVER_URL on the stack). */
export const PAYIN_DELIVER_URL = `http://${HOST}:${CHAIN_PORTS.relay}/payin-deliver`;
/** The TEST pay-in partner's own address on this anvil: impersonated, it sends each delivery. */
export const PAYIN_PARTNER = '0x0000000000000000000000000000000000ba1d01';
/** The TEST chain's TEST USD (services/svc-protocol/scripts/seed-test-chain.ts TEST_TOKENS.USD): the USDC it delivers. */
const PAYIN_TOKENS = { USDC: { address: '0x000000000000000000000000000000000000d011', decimals: 6 } };
/** FeeTokenRelay.swap's selector: the one call the TEST relayer sends. */
export const RELAY_SWAP_SELECTOR = '0xff292559';
/**
 * A second LOCAL TEST network (chain id 31337, "Local test chain"), so the explorer's search has two networks to look a
 * hash up on (J-dex-protocol-09 #10). Nothing is seeded on it; it has its own gate, which a journey may shut alone.
 */
export const SECOND_CHAIN_ID = 31337;
export const SECOND_CHAIN_PORTS = { gate: CHAIN_PORTS.secondGate, anvil: CHAIN_PORTS.secondAnvil };
export const SECOND_GATE_URL = `http://${HOST}:${SECOND_CHAIN_PORTS.gate}`;

/**
 * The TEST bridge (D-bridge-chain-03): TestBridgeToken's runtime code at one fixed address on both TEST chains, its
 * attester anvil's dev account #0 (unlocked on both, public mnemonic, worthless). TEST only.
 */
export const BRIDGE_TOKEN = '0x000000000000000000000000000000000000b41d';
const BRIDGE_ATTESTER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
/** The blocks a burn waits on top of it before the TEST attester signs it, so the row reads burn submitted first. */
const BRIDGE_CONFIRMATIONS = 3;
/** The TEST attester's URL (svc-protocol's PROTOCOL_BRIDGE_ATTESTER_URL on the stack). */
export const BRIDGE_ATTESTER_URL = `http://${HOST}:${CHAIN_PORTS.relay}/bridge-attestation`;
const BURNED_TOPIC = '0x4607200a6ff772a0fc9e5a46711cabae1f14a9b73205ac2fd9dba0e37a51d7e9';
/** Each TEST chain's own anvil port, by chain id. */
const ANVIL_PORT = { [TEST_CHAIN_ID]: CHAIN_PORTS.anvil, [SECOND_CHAIN_ID]: SECOND_CHAIN_PORTS.anvil };

/**
 * Installs the TEST bridge token on both TEST chains where it is not there yet; the stack runs it after the seed. The
 * stack waits only for the first chain (through its gate), so each anvil is first given up to `waitMs` to answer: a
 * second anvil still binding its port is waited for, never reported as a failed start (#9549).
 */
export async function installTestBridge({ ports = Object.values(ANVIL_PORT), waitMs = 30_000 } = {}) {
  const { deployedBytecode } = JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, 'contracts', 'out', 'TestBridgeToken.json'), 'utf8'));
  if (!/^0x[0-9a-f]+$/i.test(deployedBytecode)) throw new Error('TestBridgeToken.json holds no runtime code');
  for (const port of ports) {
    await anvilAnswers(port, waitMs);
    const code = await anvilRpc('eth_getCode', [BRIDGE_TOKEN, 'latest'], port);
    if (code === deployedBytecode) continue;
    await anvilRpc('anvil_setCode', [BRIDGE_TOKEN, deployedBytecode], port);
  }
}

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
      const at = new URL(req.url, `http://${HOST}`).pathname;
      void (at === '/navigator'
        ? navigatorSign(req, res)
        : at === '/payin-deliver'
          ? payinDeliver(req, res)
          : at === '/academy-refund'
            ? academyRefund(req, res)
            : at === '/bridge-attestation'
              ? bridgeAttestation(req, res)
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

/**
 * One JSON-RPC call to this stack's anvil, straight to its port (the relayer has its own connection, not the gate);
 * `port` names the second chain's anvil instead.
 */
async function anvilRpc(method, params, port = CHAIN_PORTS.anvil) {
  const res = await fetch(`http://${HOST}:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = await res.json();
  if (answer.error) throw new Error(answer.error.message ?? JSON.stringify(answer.error));
  return answer.result;
}

/**
 * Waits until the anvil on `port` answers eth_chainId, for at most `waitMs`. Only a refused or failed connection (fetch's
 * TypeError) is waited out; an anvil that answers with an error throws at once.
 */
async function anvilAnswers(port, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await anvilRpc('eth_chainId', [], port);
      return;
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      if (Date.now() >= deadline)
        throw new Error(
          `the TEST chain's anvil on port ${port} never answered within ${waitMs / 1000} s (${err.cause?.code ?? err.message})`,
        );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

/** The refunds the TEST refund signer has sent or is sending, by key (a promise of its hash), so the same key never sends twice (kept for this chain's life). */
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
  // The key is held before anything is awaited, so two requests at once share the one send and answer its one hash.
  let sending = academyRefunds.get(call.key);
  if (!sending) {
    const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const data = `0xa9059cbb${pad(call.to)}${pad(BigInt(call.amount).toString(16))}`;
    sending = (async () => {
      await anvilRpc('anvil_impersonateAccount', [ACADEMY_TEST_RECEIVER]);
      // TEST ETH for gas only; the call itself carries no value.
      await anvilRpc('anvil_setBalance', [ACADEMY_TEST_RECEIVER, '0x56bc75e2d63100000']);
      return anvilRpc('eth_sendTransaction', [{ from: ACADEMY_TEST_RECEIVER, to: usd, data, value: '0x0' }]);
    })();
    academyRefunds.set(call.key, sending);
    // A send that failed before it reached the chain frees the key for the next try.
    sending.catch(() => academyRefunds.delete(call.key));
  }
  try {
    return answer(200, { hash: await sending });
  } catch (err) {
    return answer(502, { error: `refund.send_failed: ${err.message}` });
  }
}

/** Sends one call from an impersonated address and waits until it is mined; the hash, or an error when it reverted. */
async function sendMined(tx) {
  const hash = await anvilRpc('eth_sendTransaction', [tx]);
  for (let i = 0; i < 120; i++) {
    const receipt = await anvilRpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`reverted: ${hash}`);
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`not mined within 60 s: ${hash}`);
}

/** Whole units of a decimal string with at most `decimals` places, or null when it is not one or is not above zero. */
function toUnits(amount, decimals) {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(typeof amount === 'string' ? amount : '');
  if (!m || (m[2] ?? '').length > decimals) return null;
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
  return units > 0n ? units : null;
}

const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * POST /payin-deliver {to, asset, amount, key?} (amount a decimal string): the TEST pay-in partner delivers `amount` of
 * `asset` to `to` on the TEST chain. It mints the TEST token to its own address, then sends one transfer from there to
 * `to`, each mined before the next. Only the assets PAYIN_TOKENS lists; anything else is refused by name. Answers {hash}
 * (the transfer's) or {error}. With a `key` (a move from a person's own partner account to their wallet,
 * J-derivatives-25 #2) it sends once per key, as a partner must: the same key and terms answer the first hash and send
 * nothing more, other terms are refused, and two calls under one key at once share the one send.
 */
const payinSent = new Map();
async function payinDeliver(req, res) {
  const answer = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return answer(404, { error: 'payin.not_found: POST /payin-deliver only' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4_000) return answer(413, { error: 'payin.too_large' });
  }
  let call;
  try {
    call = JSON.parse(raw);
  } catch {
    return answer(400, { error: 'payin.bad_json' });
  }
  if (typeof call?.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(call.to)) return answer(400, { error: 'payin.bad_to' });
  const token = Object.hasOwn(PAYIN_TOKENS, call.asset) ? PAYIN_TOKENS[call.asset] : null;
  if (!token) return answer(400, { error: `payin.wrong_asset: only ${Object.keys(PAYIN_TOKENS).join(', ')} is delivered` });
  const units = toUnits(call.amount, token.decimals);
  if (units === null) return answer(400, { error: 'payin.bad_amount' });
  if (call.key !== undefined && (typeof call.key !== 'string' || call.key.length < 8 || call.key.length > 160)) {
    return answer(400, { error: 'payin.bad_key' });
  }
  if (call.key !== undefined) {
    const terms = `${call.to.toLowerCase()}|${call.asset}|${units}`;
    const prior = payinSent.get(call.key);
    if (prior && prior.terms !== terms) return answer(409, { error: 'payin.key_conflict: this key was sent with other terms' });
    const sending = prior ?? { terms, hash: send(token, call.to, units) };
    if (!prior) payinSent.set(call.key, sending);
    try {
      return answer(200, { hash: await sending.hash });
    } catch (err) {
      // Nothing was sent under the key (a send that failed before its transfer was mined): it may be asked again.
      if (payinSent.get(call.key) === sending) payinSent.delete(call.key);
      return answer(502, { error: `payin.send_failed: ${err.message}` });
    }
  }
  try {
    return answer(200, { hash: await send(token, call.to, units) });
  } catch (err) {
    return answer(502, { error: `payin.send_failed: ${err.message}` });
  }
}

/** The TEST pay-in partner's one delivery: mint to itself, then transfer to `to`, each mined; the transfer's hash. */
async function send(token, to, units) {
  await anvilRpc('anvil_impersonateAccount', [PAYIN_PARTNER]);
  // TEST ETH for gas only; neither call carries value.
  await anvilRpc('anvil_setBalance', [PAYIN_PARTNER, '0x56bc75e2d63100000']);
  // mint(address,uint256): the TEST token mints to anyone; the partner holds exactly what it then delivers.
  await sendMined({
    from: PAYIN_PARTNER,
    to: token.address,
    data: `0x40c10f19${word(PAYIN_PARTNER)}${word(units.toString(16))}`,
    value: '0x0',
  });
  // transfer(address,uint256): the delivery itself.
  return await sendMined({
    from: PAYIN_PARTNER,
    to: token.address,
    data: `0xa9059cbb${word(to)}${word(units.toString(16))}`,
    value: '0x0',
  });
}

/**
 * GET /bridge-attestation?chainId=<source>&tx=<burn hash>: the TEST attester. Answers {status: 'pending'} until the burn
 * is mined with BRIDGE_CONFIRMATIONS blocks on top, then {status: 'ready', intentId, sourceChainId, destinationChainId,
 * recipient, amount, attestation}; a transaction that is not a TEST bridge burn is refused by name. It sends nothing.
 */
async function bridgeAttestation(req, res) {
  const answer = (status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const params = new URL(req.url, `http://${HOST}`).searchParams;
  const sourceChainId = Number(params.get('chainId'));
  const tx = params.get('tx') ?? '';
  const sourcePort = ANVIL_PORT[sourceChainId];
  if (req.method !== 'GET' || !sourcePort) return answer(404, { error: 'attestation.not_found: GET with a TEST chain id' });
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return answer(400, { error: 'attestation.bad_tx' });
  try {
    const receipt = await anvilRpc('eth_getTransactionReceipt', [tx], sourcePort);
    if (!receipt) return answer(200, { status: 'pending' });
    if (receipt.status !== '0x1') return answer(422, { error: 'attestation.reverted: the burn reverted' });
    const log = receipt.logs.find((l) => l.address.toLowerCase() === BRIDGE_TOKEN && l.topics[0] === BURNED_TOPIC);
    if (!log) return answer(422, { error: 'attestation.not_a_burn: the transaction burned no TEST bridge token' });
    const head = BigInt(await anvilRpc('eth_blockNumber', [], sourcePort));
    if (head - BigInt(receipt.blockNumber) < BigInt(BRIDGE_CONFIRMATIONS)) return answer(200, { status: 'pending' });
    const data = log.data.slice(2);
    const destinationChainId = Number(BigInt(`0x${data.slice(0, 64)}`));
    const recipient = `0x${data.slice(64 + 24, 128)}`;
    const amount = BigInt(`0x${data.slice(128, 192)}`);
    const destPort = ANVIL_PORT[destinationChainId];
    if (!destPort) return answer(422, { error: 'attestation.unknown_destination: the burn names no TEST chain' });
    const intentId = log.topics[1];
    // attestationDigest(bytes32,uint256,address,uint256), read on the destination chain, where the mint checks it.
    const digest = await anvilRpc(
      'eth_call',
      [
        {
          to: BRIDGE_TOKEN,
          data: `0x1438de04${word(intentId)}${word(sourceChainId.toString(16))}${word(recipient)}${word(amount.toString(16))}`,
        },
        'latest',
      ],
      destPort,
    );
    const attestation = await anvilRpc('personal_sign', [digest, BRIDGE_ATTESTER], destPort);
    return answer(200, {
      status: 'ready',
      intentId,
      sourceChainId,
      destinationChainId,
      recipient,
      amount: amount.toString(),
      attestation,
    });
  } catch (err) {
    return answer(502, { error: `attestation.failed: ${err.message}` });
  }
}

/** `fund <address> bridge`: TEST ETH for gas on both TEST chains and 100 TEST USDC of the TEST bridge token on the first. */
async function fundBridge(address) {
  await installTestBridge();
  for (const port of Object.values(ANVIL_PORT)) await anvilRpc('anvil_setBalance', [address, '0x56bc75e2d63100000'], port);
  // issue(address,uint256): the TEST faucet, which only the attester (anvil's unlocked dev account) may call.
  await sendMined({
    from: BRIDGE_ATTESTER,
    to: BRIDGE_TOKEN,
    data: `0x867904b4${word(address)}${word((100_000_000).toString(16))}`,
    value: '0x0',
  });
  console.log(
    `bridge funding for ${address}: TEST ETH on chains ${Object.keys(ANVIL_PORT).join(' and ')}, 100 TEST USDC on ${TEST_CHAIN_ID}`,
  );
}

async function cmdGate(state, network) {
  if (!['open', 'closed'].includes(state) || ![undefined, 'second'].includes(network)) throw new Error('usage: gate open|closed [second]');
  const answer = await control(`?gate=${state}${network ? `&network=${network}` : ''}`);
  // No TEST chain on this stack: svc-protocol's RPC is UNUSED, which is already "closed".
  console.log(JSON.stringify(answer ?? { chain: 'absent', gate: 'closed' }));
}

async function cmdFund(address, kind) {
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(address ?? '') ||
    ![undefined, 'stable', 'spam', 'venue', 'plain', 'reset', 'positions', 'bridge'].includes(kind)
  )
    throw new Error('usage: fund <0x address> [stable|spam|venue|plain|reset|positions|bridge]');
  const status = await chainStatus();
  if (status.chain !== 'running') {
    console.error('local-test-chain.no_chain: this stack runs no TEST chain (no anvil binary), so nothing can be funded');
    process.exit(1);
  }
  if (status.gate !== 'open') {
    console.error('local-test-chain.gate_closed: the TEST chain gate is closed; open it before funding');
    process.exit(1);
  }
  if (kind === 'bridge') return fundBridge(address);
  // `positions` reads the lending market and venue from the chain's record.
  const r = runSeedScript(['fund', address, ...(kind ? [kind] : []), ...(kind === 'positions' ? [chainRecordPath()] : [])]);
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
    console.error(
      'usage: local-test-chain.mjs serve | status | gate open|closed [second] | fund <address> [stable|spam|venue|plain|positions|bridge]',
    );
    process.exit(2);
  }
}
