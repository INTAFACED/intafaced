// local-test-chain.mjs and the protocol service's env: with no TEST chain the stack behaves as before (UNUSED RPC, gate a
// no-op, fund refused by name); with one, svc-protocol reads the chain through its gate. Starts no anvil.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  anvilBin,
  CHAIN_PORTS,
  installTestBridge,
  GATE_URL,
  RELAY_URL,
  SECOND_CHAIN_ID,
  SECOND_CHAIN_PORTS,
  SECOND_GATE_URL,
  TEST_CHAIN_ID,
} from './local-test-chain.mjs';
import indexer from './local-stack-services/indexer.mjs';
import protocol from './local-stack-services/protocol.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'local-test-chain.mjs');
const UNUSED = 'http://127.0.0.1:1';
const ctx = (testChain) => ({
  c: () => ({}),
  secrets: {},
  dbUrl: () => 'postgres://x',
  PORTS: { protocol: 14520 },
  UNUSED,
  testChain,
});

test('the TEST chain is the app network id on loopback, gate apart from anvil', () => {
  assert.equal(TEST_CHAIN_ID, 84532);
  assert.equal(GATE_URL, `http://127.0.0.1:${CHAIN_PORTS.gate}`);
  assert.notEqual(CHAIN_PORTS.gate, CHAIN_PORTS.anvil);
  for (const port of Object.values(CHAIN_PORTS)) assert.ok(![8545, 8546].includes(port), 'never the unit-test chains');
});

test('the second TEST network is the local test chain id, on its own loopback ports', () => {
  assert.equal(SECOND_CHAIN_ID, 31337);
  assert.notEqual(SECOND_CHAIN_ID, TEST_CHAIN_ID);
  assert.equal(SECOND_GATE_URL, `http://127.0.0.1:${SECOND_CHAIN_PORTS.gate}`);
  const ports = Object.values(CHAIN_PORTS);
  assert.equal(new Set(ports).size, ports.length, 'no port shared between the two chains');
  for (const port of Object.values(SECOND_CHAIN_PORTS)) assert.ok(ports.includes(port), 'the stack checks the second network’s ports too');
  for (const port of ports) assert.ok(![8545, 8546].includes(port), 'never the unit-test chains');
});

test('svc-indexer searches the second TEST network only when the stack runs the chains', () => {
  const env = (testChain) => indexer({ ...ctx(testChain), PORTS: { indexer: 14523 } }).env();
  assert.equal(env(() => null).INDEXER_SEARCH_NETWORKS, '');
  const chain = { rpcUrl: GATE_URL, factory: '0x1', router: '0x2' };
  assert.deepEqual(JSON.parse(env(() => chain).INDEXER_SEARCH_NETWORKS), [{ chainId: 31337, rpcUrl: SECOND_GATE_URL }]);
});

test('svc-protocol keeps UNUSED and the zero factory when the stack runs no TEST chain', () => {
  for (const testChain of [undefined, () => null]) {
    const env = protocol(ctx(testChain)).env();
    assert.equal(env.PROTOCOL_RPC_URL, UNUSED);
    assert.equal(env.PROTOCOL_CHAIN_ID, '84532');
    assert.equal('PROTOCOL_AMM_FACTORY_ADDRESS' in env, false);
  }
});

test('svc-protocol pays fees in a token only through the seeded TEST fee relay and its TEST relayer', () => {
  const env = (testChain) => protocol(ctx(testChain)).env();
  for (const name of ['PROTOCOL_FEE_RELAY_ADDRESS', 'PROTOCOL_FEE_RELAY_URL', 'PROTOCOL_FEE_RELAY_GAS_LIMIT']) {
    assert.equal(name in env(() => null), false, `${name} stays blank with no chain`);
    assert.equal(
      name in env(() => ({ rpcUrl: GATE_URL, factory: '0x1', router: '0x2', feeRelay: null })),
      false,
      `${name} blank before the relay is seeded`,
    );
  }
  const relay = '0x9d4454b023096f34b160d6b654540c56a1f81688';
  const seeded = env(() => ({ rpcUrl: GATE_URL, factory: '0x1', router: '0x2', feeRelay: relay }));
  assert.equal(seeded.PROTOCOL_FEE_RELAY_ADDRESS, relay);
  assert.equal(seeded.PROTOCOL_FEE_RELAY_URL, RELAY_URL);
  assert.equal(new URL(RELAY_URL).hostname, '127.0.0.1');
  assert.equal(new URL(RELAY_URL).port, String(CHAIN_PORTS.relay));
  assert.match(seeded.PROTOCOL_FEE_RELAY_GAS_LIMIT, /^[1-9]\d*$/);
});

test('svc-protocol reads the TEST chain through its gate, with the seeded factory', () => {
  const factory = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';
  const env = protocol(ctx(() => ({ rpcUrl: GATE_URL, factory, router: '0x1' }))).env();
  assert.equal(env.PROTOCOL_RPC_URL, GATE_URL);
  assert.equal(env.PROTOCOL_AMM_FACTORY_ADDRESS, factory);
  assert.equal('PROTOCOL_SWAP_PAYMASTER_ADDRESS' in env, false, 'swap paymaster stays blank by default');
});

test('anvilBin: the named binary only if it exists, else anvil on PATH, else none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-test-chain-'));
  try {
    assert.equal(anvilBin({ LOCAL_STACK_ANVIL_BIN: join(dir, 'missing'), PATH: dir }), null);
    assert.equal(anvilBin({ PATH: dir }), null);
    const bin = join(dir, 'anvil');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    assert.equal(anvilBin({ PATH: dir }), bin);
    assert.equal(anvilBin({ LOCAL_STACK_ANVIL_BIN: bin, PATH: '' }), bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Run with no stack chain on this machine (nothing on the control port), as on a CI runner before the stack starts.
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('with no TEST chain: status says absent, gate is a no-op, fund refuses by name', () => {
  assert.deepEqual(JSON.parse(run('status').stdout), { chain: 'absent' });
  const gate = run('gate', 'closed');
  assert.equal(gate.status, 0);
  assert.deepEqual(JSON.parse(gate.stdout), { chain: 'absent', gate: 'closed' });
  const fund = run('fund', '0x52908400098527886E0F7030069857D2E4169EE7');
  assert.equal(fund.status, 1);
  assert.match(fund.stderr, /local-test-chain\.no_chain/);
  assert.equal(run('fund', 'not-an-address').status, 1);
  assert.equal(run('fund', '0x52908400098527886E0F7030069857D2E4169EE7', 'everything').status, 1, 'only `stable` names another funding');
  assert.equal(run('gate', 'ajar').status, 1);
  assert.equal(run('gate', 'closed', 'third').status, 1, 'only the second network has a gate of its own');
});

// #9549: the stack installs the TEST bridge on both anvils, but waits only for the first one (through its gate). A
// second anvil still binding its port then failed the whole start with "fetch failed". Here the "anvil" starts
// listening only after the install began; the install must wait for it, and still fail by name when none ever answers.
test('installTestBridge waits for an anvil that starts listening late, and names one that never does', async () => {
  const { createServer } = await import('node:http');
  const free = () =>
    new Promise((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  const port = await free();
  const calls = [];
  const anvil = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { method } = JSON.parse(raw);
    calls.push(method);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'eth_getCode' ? '0x' : method === 'eth_chainId' ? '0x7a69' : null }),
    );
  });
  const late = setTimeout(() => anvil.listen(port, '127.0.0.1'), 1500);
  try {
    await installTestBridge({ ports: [port], waitMs: 20_000 });
    assert.ok(calls.includes('anvil_setCode'), `the bridge code was installed once the anvil answered: ${calls.join(', ')}`);
  } finally {
    clearTimeout(late);
    await new Promise((resolve) => anvil.close(resolve));
  }
  const silent = await free();
  await assert.rejects(installTestBridge({ ports: [silent], waitMs: 1000 }), new RegExp(`anvil on port ${silent} never answered`));
});
