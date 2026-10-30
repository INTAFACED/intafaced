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
  GATE_URL,
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

test('svc-protocol reads the TEST chain through its gate, with the seeded factory', () => {
  const factory = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';
  const env = protocol(ctx(() => ({ rpcUrl: GATE_URL, factory, router: '0x1' }))).env();
  assert.equal(env.PROTOCOL_RPC_URL, GATE_URL);
  assert.equal(env.PROTOCOL_AMM_FACTORY_ADDRESS, factory);
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
  assert.equal(run('gate', 'ajar').status, 1);
  assert.equal(run('gate', 'closed', 'third').status, 1, 'only the second network has a gate of its own');
});
