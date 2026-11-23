#!/usr/bin/env node
/**
 * Linked Trade+Depth decimal-string roundtrip OUTSIDE the vitest worker.
 * spawnSync Java here cannot block birpc — this is a plain Node process.
 * Unlinked: print sbe_unavailable and exit 0 (same honesty as the old it()).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// The repo's one compiler entry (tsrs off CI, tsc in CI; tooling/scripts/tsc.mjs).
const tsc = join(ROOT, '..', '..', 'tooling', 'scripts', 'tsc.mjs');
const compiled = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.json')], { cwd: ROOT, stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status === null ? 1 : compiled.status);

const { sbeCodec } = await import(pathToFileURL(join(ROOT, 'dist', 'codec.js')).href);
const { SBE_UNAVAILABLE } = await import(pathToFileURL(join(ROOT, 'dist', 'types.js')).href);

const trade = {
  template: 'Trade',
  instrument: 'BTCUSDT',
  tradeId: '9',
  side: 'buy',
  price: '100.25',
  qty: '1.50',
  eventTimeNs: '1',
};

if (!sbeCodec.linked) {
  const result = sbeCodec.encode(trade);
  if (result.ok) fail('unlinked codec encoded a Trade — must refuse sbe_unavailable');
  if (result.reason !== SBE_UNAVAILABLE) fail(`unlinked refuse reason ${result.reason}, expected ${SBE_UNAVAILABLE}`);
  if ('payload' in result) fail('unlinked refuse must not carry a payload');
  process.stdout.write(`${SBE_UNAVAILABLE} — Java SBE not linked\n`);
  process.exit(0);
}

const encoded = sbeCodec.encode(trade);
if (!encoded.ok) fail(`linked Trade encode refused: ${encoded.reason} ${encoded.message}`);
if (encoded.template !== 'Trade') fail(`linked Trade template ${encoded.template}`);
if (encoded.payload.byteLength <= 8) fail('linked Trade payload too short');
const decoded = sbeCodec.decode(encoded.payload);
if (!decoded.ok) fail(`linked Trade decode refused: ${decoded.reason} ${decoded.message}`);
if (decoded.template !== 'Trade') fail(`decoded template ${decoded.template}`);
if (decoded.instrument !== 'BTCUSDT' || decoded.side !== 'buy' || decoded.tradeId !== '9') {
  fail('linked Trade identity fields drifted');
}
if (decoded.price !== '100.25' || decoded.qty !== '1.5') {
  fail(`linked Trade money drifted price=${decoded.price} qty=${decoded.qty}`);
}
if (typeof decoded.price !== 'string' || typeof decoded.qty !== 'string') {
  fail('linked Trade money must stay decimal strings');
}
process.stdout.write(`linked Trade roundtrip ok price=${decoded.price} qty=${decoded.qty}\n`);

const depthEncoded = sbeCodec.encode({
  template: 'DepthLevel',
  instrument: 'ETHUSDT',
  sequence: '7',
  side: 'sell',
  price: '0.00000001',
  qty: '12',
  eventTimeNs: '2',
});
if (!depthEncoded.ok) fail(`linked Depth encode refused: ${depthEncoded.reason} ${depthEncoded.message}`);
const depthDecoded = sbeCodec.decode(depthEncoded.payloadB64);
if (!depthDecoded.ok) fail(`linked Depth decode refused: ${depthDecoded.reason} ${depthDecoded.message}`);
if (depthDecoded.template !== 'DepthLevel') fail(`decoded depth template ${depthDecoded.template}`);
if (depthDecoded.price !== '0.00000001' || depthDecoded.qty !== '12' || depthDecoded.side !== 'sell') {
  fail(`linked Depth drifted price=${depthDecoded.price} qty=${depthDecoded.qty} side=${depthDecoded.side}`);
}
process.stdout.write(`linked Depth roundtrip ok price=${depthDecoded.price} qty=${depthDecoded.qty}\n`);
process.exit(0);
