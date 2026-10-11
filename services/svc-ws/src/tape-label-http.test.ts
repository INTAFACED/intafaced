import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { encodeL2Snapshot } from './sbe-l2-tape.js';
import { handleTapeLabelDoor, registerTapeLabelDoor } from './tape-label-http.js';
import {
  refuseGlobalConnectedLie,
  refuseInstrumentRemap,
  refuseL2AsL3,
  refuseUnlabelledTapeClaim,
  refuseUnsetTapeOrigin,
} from './tape-label-refuse.js';

const MILL = ['sbe-l2-tape.ts', 'trade/hub.ts', 'tape-label-refuse.ts'] as const;

describe('refuseUnlabelledTapeClaim', () => {
  it('refuses a completeness claim without aggressor/auction/liq/block', () => {
    expect(refuseUnlabelledTapeClaim({ complete: true })).toMatchObject({ ok: false, reason: 'tape_label_unset' });
    expect(refuseUnlabelledTapeClaim({ complete: true, kind: 'unknown' })).toMatchObject({
      ok: false,
      reason: 'tape_label_unset',
    });
  });
  it('accepts a named aggressor/auction/liq/block label', () => {
    expect(refuseUnlabelledTapeClaim({ complete: true, kind: 'aggressor' })).toBeNull();
    expect(refuseUnlabelledTapeClaim({ complete: true, kind: 'auction' })).toBeNull();
    expect(refuseUnlabelledTapeClaim({ complete: true, kind: 'liquidation' })).toBeNull();
    expect(refuseUnlabelledTapeClaim({ complete: true, kind: 'block' })).toBeNull();
    expect(refuseUnlabelledTapeClaim({})).toBeNull();
  });
});

describe('refuseUnsetTapeOrigin', () => {
  it('distinguishes synthetic/implied from native — never infers native', () => {
    expect(refuseUnsetTapeOrigin({ native: true })).toMatchObject({ ok: false, reason: 'origin_unset' });
    expect(refuseUnsetTapeOrigin({ origin: 'native', synthetic: true })).toMatchObject({
      ok: false,
      reason: 'origin_unset',
    });
    expect(refuseUnsetTapeOrigin({ implied: true })).toMatchObject({ ok: false, reason: 'origin_unset' });
    expect(refuseUnsetTapeOrigin({ origin: 'implied' })).toBeNull();
    expect(refuseUnsetTapeOrigin({ origin: 'native', native: true })).toBeNull();
  });
});

describe('refuseGlobalConnectedLie', () => {
  it('refuses a global connected without per-source truth', () => {
    expect(refuseGlobalConnectedLie({ connected: true })).toMatchObject({ ok: false, reason: 'connected_lie' });
    expect(refuseGlobalConnectedLie({ connected: true, depth: true, tradesBus: false, privateBus: true })).toMatchObject({
      ok: false,
      reason: 'connected_lie',
    });
    expect(refuseGlobalConnectedLie({ connected: true, tradesBus: true, privateBus: true })).toMatchObject({
      ok: false,
      reason: 'connected_lie',
    });
    expect(refuseGlobalConnectedLie({ connected: true, depth: true, privateBus: true })).toMatchObject({
      ok: false,
      reason: 'connected_lie',
    });
    expect(refuseGlobalConnectedLie({ connected: true, depth: true, tradesBus: true })).toMatchObject({
      ok: false,
      reason: 'connected_lie',
    });
    expect(refuseGlobalConnectedLie({ connected: true, depth: true, tradesBus: true, privateBus: true })).toBeNull();
    expect(refuseGlobalConnectedLie({})).toBeNull();
  });
});

describe('refuseInstrumentRemap', () => {
  it('refuses an adapter that reinterprets a listed instrument', () => {
    expect(refuseInstrumentRemap({ remap: true })).toMatchObject({ ok: false, reason: 'instrument_remap' });
    expect(refuseInstrumentRemap({ listedMarketId: 'BTC-USDT', adapterMarketId: 'XBTUSD' })).toMatchObject({
      ok: false,
      reason: 'instrument_remap',
    });
    expect(refuseInstrumentRemap({ listedMarketId: 'BTC-USDT', adapterMarketId: 'BTC-USDT' })).toBeNull();
  });
});

describe('refuseL2AsL3', () => {
  it('never calls L2 L3', () => {
    expect(refuseL2AsL3({ book: 'L2', as: 'L3' })).toMatchObject({ ok: false, reason: 'l2_is_not_l3' });
    expect(refuseL2AsL3({ channel: 'queue-probability' })).toMatchObject({ ok: false, reason: 'l2_is_not_l3' });
    expect(refuseL2AsL3({ book: 'L2' })).toBeNull();
  });
});

describe('POST /ws/tape/*', () => {
  async function app() {
    const f = Fastify();
    registerTapeLabelDoor(f);
    await f.ready();
    return f;
  }
  it('unlabelled completeness claim refuses', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/ws/tape/label-claim', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'tape_label_unset' });
    await f.close();
  });
  it('global connected without sources refuses', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/ws/tape/connected-claim', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'connected_lie' });
    await f.close();
  });
  it('instrument remap refuses', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/ws/tape/instrument-map',
      payload: { listedMarketId: 'BTC-USDT', adapterMarketId: 'XBTUSD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'instrument_remap' });
    await f.close();
  });
  it('handleTapeLabelDoor never invents native or L3', () => {
    expect(handleTapeLabelDoor({ native: true })).toMatchObject({ ok: false, reason: 'origin_unset' });
    expect(handleTapeLabelDoor({ book: 'L2', as: 'L3' })).toMatchObject({ ok: false, reason: 'l2_is_not_l3' });
  });
});

describe('C4 L2 tape stays L2', () => {
  it('encodeL2Snapshot names book L2 and never L3', () => {
    const codec = {
      linked: true,
      encode: () => ({ ok: true as const, payload: new Uint8Array([1]) }),
    };
    const encoded = encodeL2Snapshot(codec as never, {
      marketId: 'BTC-USDT',
      sequence: 1,
      bids: [['100', '1']],
      asks: [['101', '1']],
    });
    expect(encoded).toMatchObject({ ok: true, book: 'L2' });
    expect(JSON.stringify(encoded)).not.toMatch(/L3/);
  });
});

describe('tape mills stay mill', () => {
  it('sbe-l2-tape / TradeHub / refuse never match withdrawHold', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const name of MILL) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toMatch(/withdrawHold/);
    }
  });
});
