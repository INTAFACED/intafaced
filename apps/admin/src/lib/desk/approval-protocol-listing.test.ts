import { describe, expect, it } from 'vitest';
import { approvalPayloadHash } from '../../../../../services/svc-ops/src/operator-desks';
import {
  confirmPhrase,
  decodePacket,
  describeRequest,
  encodePacket,
  readDeskRequest,
  requestReason,
  type DeskRequest,
} from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';

/** The hash is pinned to svc-ops' own function, so drift fails here instead of making every approval unusable. */
const POOL = '0xAbCdEf0123456789aBcDeF0123456789abCDef01';
const hidePool: DeskRequest = {
  kind: 'protocol.pool.hide',
  chainId: 84532,
  poolAddress: POOL,
  reasonCode: 'scam_report',
  reason: 'TEST reported as a copy of a listed token',
};
const restorePool: DeskRequest = { kind: 'protocol.pool.restore', chainId: 84532, poolAddress: POOL };
const delist: DeskRequest = {
  kind: 'protocol.market.delist',
  symbol: 'IFC-USD',
  reasonCode: 'scam_report',
  reason: 'TEST reported as a copy',
};
const relist: DeskRequest = { kind: 'protocol.market.restore', symbol: 'IFC-USD' };

describe('protocol listing requests', () => {
  it('hash exactly what svc-ops hashes', () => {
    const poolId = `84532:${POOL.toLowerCase()}`;
    expect(payloadHashFor(hidePool)).toBe(
      approvalPayloadHash('protocol.pool.hide', {
        targetId: poolId,
        reasonCode: 'scam_report',
        reason: 'TEST reported as a copy of a listed token',
      }),
    );
    expect(payloadHashFor(restorePool)).toBe(approvalPayloadHash('protocol.pool.restore', { targetId: poolId }));
    expect(payloadHashFor(delist)).toBe(
      approvalPayloadHash('protocol.market.delist', { targetId: 'IFC-USD', reasonCode: 'scam_report', reason: 'TEST reported as a copy' }),
    );
    expect(payloadHashFor(relist)).toBe(approvalPayloadHash('protocol.market.restore', { targetId: 'IFC-USD' }));
  });

  it('a changed pool, reason code or reason is a different request', () => {
    const base = payloadHashFor(hidePool);
    for (const change of [
      { chainId: 1 },
      { poolAddress: '0x0000000000000000000000000000000000000001' },
      { reasonCode: 'other' },
      { reason: 'TEST a different reason entirely' },
    ]) {
      expect(payloadHashFor({ ...hidePool, ...change } as DeskRequest)).not.toBe(base);
    }
  });

  it('is proposed against svc-ops for the pool or market itself', () => {
    expect(proposeInputFor(hidePool)).toMatchObject({
      actionType: 'protocol.pool.hide',
      targetService: 'svc-ops',
      targetId: `84532:${POOL.toLowerCase()}`,
      expectedVersion: '1',
    });
    expect(proposeInputFor(delist)).toMatchObject({ actionType: 'protocol.market.delist', targetService: 'svc-ops', targetId: 'IFC-USD' });
  });

  it('survives a packet round trip and is read strictly', () => {
    for (const request of [hidePool, restorePool, delist, relist]) {
      expect(readDeskRequest(request)).toEqual(request);
      const read = decodePacket(
        encodePacket({ request, approvalId: 'appr_1', operationId: 'op_1', expiresAt: '2026-10-20T11:00:00.000Z', requesterId: 'u1' }),
      );
      expect(read).toMatchObject({ ok: true, packet: { request } });
      expect(readDeskRequest({ ...request, extra: 1 })).toBeNull();
      expect(confirmPhrase(request)).not.toBe('');
      expect(describeRequest(request)).toMatch(/pool|market/i);
    }
    expect(readDeskRequest({ ...hidePool, poolAddress: '0x12' })).toBeNull();
    expect(readDeskRequest({ ...hidePool, chainId: 0 })).toBeNull();
    expect(readDeskRequest({ ...hidePool, reason: 'short' })).toBeNull();
    expect(readDeskRequest({ ...hidePool, reasonCode: 'has space' })).toBeNull();
    expect(readDeskRequest({ ...delist, symbol: ' ifc-usd' })).toBeNull();
    expect(readDeskRequest({ ...restorePool, reason: 'a restore carries no reason' })).toBeNull();
  });

  it('says a hide is a listing decision and a restore needs no reason', () => {
    expect(describeRequest(hidePool)).toMatch(/listing decision only/);
    expect(requestReason(hidePool)).toBe(hidePool.reason);
    expect(requestReason(restorePool)).toBeNull();
    expect(requestReason(relist)).toBeNull();
  });
});
