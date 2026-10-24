import { describe, expect, it } from 'vitest';
import { readDeskRequest } from '@/lib/desk/approval-packet';
import { freezeDetail, readFreezeAnswer, readFreezeRequest, readUnfreezeAnswer, unfreezeDetail } from './model';

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const FREEZE = '7d8c9b0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const ADDRESS = '0x00000000000000000000000000000000000000a1';
const freeze = { id: FREEZE, userId: USER, networkId: 'ethereum', address: ADDRESS };

describe('deposit address freeze requests', () => {
  it('reads exactly the freeze shape, trims the reason, and refuses a short one or an extra field', () => {
    const body = { userId: USER, networkId: 'ethereum', address: ADDRESS, reason: '  compliance review of the source  ' };
    expect(readFreezeRequest(body)).toEqual({ ...body, reason: 'compliance review of the source' });
    expect(readFreezeRequest({ ...body, reason: 'too short' })).toBeNull();
    expect(readFreezeRequest({ ...body, amount: '1' })).toBeNull();
    expect(readFreezeRequest({ ...body, userId: 'not-a-uuid' })).toBeNull();
    expect(readFreezeRequest({ ...body, address: 'has space' })).toBeNull();
  });

  it('reads the unfreeze desk request with its freeze id, and refuses one without it', () => {
    const request = {
      kind: 'pay.deposit_address.unfreeze',
      userId: USER,
      networkId: 'ethereum',
      address: ADDRESS,
      freezeId: FREEZE,
      reason: 'Source cleared by compliance',
    };
    expect(readDeskRequest(request)).toEqual(request);
    const { freezeId: _drop, ...noFreeze } = request;
    expect(readDeskRequest(noFreeze)).toBeNull();
    expect(readDeskRequest({ ...request, reason: ' Source cleared by compliance' })).toBeNull();
  });
});

describe('svc-pay answers', () => {
  it('reads a freeze and an unfreeze answer, and refuses one that is not that shape', () => {
    expect(readFreezeAnswer({ freeze, held: 1, creditedUntouched: 2 })).toEqual({
      freezeId: FREEZE,
      userId: USER,
      networkId: 'ethereum',
      address: ADDRESS,
      held: 1,
      creditedUntouched: 2,
    });
    expect(readFreezeAnswer({ freeze, held: -1, creditedUntouched: 0 })).toBeNull();
    expect(readUnfreezeAnswer({ freeze, released: 1, credited: 1 })).toMatchObject({ freezeId: FREEZE, released: 1, credited: 1 });
    expect(readUnfreezeAnswer({ freeze, released: 1, credited: 2 })).toBeNull();
    expect(readUnfreezeAnswer({ released: 1, credited: 1 })).toBeNull();
  });

  it('says what the freeze held and points a credited deposit to the account freeze', () => {
    expect(freezeDetail(ADDRESS, { held: 1, creditedUntouched: 0 })).toBe(
      `svc-pay froze deposit address ${ADDRESS}. 1 deposit on the way to it is on hold and not credited.`,
    );
    expect(freezeDetail(ADDRESS, { held: 0, creditedUntouched: 2 })).toContain('freeze the account under Account controls');
    expect(unfreezeDetail(ADDRESS, 2, 1)).toBe(
      `svc-pay lifted the freeze on ${ADDRESS}. 1 held deposit was credited once; 1 still waits for confirmations or a retry and will be credited once.`,
    );
    expect(unfreezeDetail(ADDRESS, 0, 0)).toBe(`svc-pay lifted the freeze on ${ADDRESS}. No deposit was held by it.`);
  });
});
