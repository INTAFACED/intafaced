import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  applyCopyDetach,
  applyCopyLeave,
  applyCopyPause,
  applyCopyResume,
  applyCopyStop,
  applyCopyStopCloseOnly,
  presentCopyControlAck,
  requireCopyFollowId,
  requireNewCopyIntentAllowed,
} from './copy-lifecycle.js';
import type { CopyFollow } from './follows.js';

const follow: CopyFollow = {
  followId: 'follow-1',
  followerId: 'follower-1',
  leaderId: 'leader-1',
  envelope: {
    permittedMarkets: ['BTC-USDT'],
    maxNotionalPerOrder: parseAmount('100'),
    maxAggregateExposure: parseAmount('1000'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  },
  region: 'SG',
  createdAt: new Date('2026-08-14T00:00:00.000Z'),
  feeShareKilled: false,
};

describe('copy lifecycle (PTX-M26-R05)', () => {
  it('missing follow id refuses', () => {
    expect(() => requireCopyFollowId('')).toThrowError(/Follow id is required/);
    expect(() => requireCopyFollowId('   ')).toThrowError(/Follow id is required/);
    expect(() => requireCopyFollowId(undefined)).toThrowError(/Follow id is required/);
  });

  it('pause fences new intent and does not invent a flatten', () => {
    const paused = applyCopyPause(follow);
    expect(paused.relationshipState).toBe('PAUSED');
    expect(paused.sessionKeyRevoked).not.toBe(true);
    const ack = presentCopyControlAck(paused, 'PAUSE_NEW');
    expect(ack).toEqual({
      followId: 'follow-1',
      relationshipState: 'PAUSED',
      disposition: 'PAUSE_NEW',
      newIntentFenced: true,
      flattenInvented: false,
      sessionKeyRevoked: false,
    });
    expect(() => requireNewCopyIntentAllowed(paused)).toThrow(/paused/i);
    try {
      requireNewCopyIntentAllowed(paused);
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.copy_paused' });
    }
  });

  it('stop revokes the grant and still does not flatten', () => {
    const stopped = applyCopyStop(follow);
    expect(stopped.relationshipState).toBe('STOPPING');
    expect(stopped.sessionKeyRevoked).toBe(true);
    expect(presentCopyControlAck(stopped, 'STOP_NEW').flattenInvented).toBe(false);
    try {
      requireNewCopyIntentAllowed(stopped);
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.copy_stopped' });
    }
  });

  it('detach keeps the follower in control and refuses new mirrors', () => {
    const detached = applyCopyDetach(follow);
    expect(detached.relationshipState).toBe('DETACHED');
    expect(detached.sessionKeyRevoked).toBe(true);
    expect(presentCopyControlAck(detached, 'DETACH_KEEP').disposition).toBe('DETACH_KEEP');
    try {
      requireNewCopyIntentAllowed(detached);
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.copy_detached' });
    }
  });

  it('pause/stop/detach acks never mark flatten invented', () => {
    expect(presentCopyControlAck(applyCopyPause(follow), 'PAUSE_NEW').flattenInvented).toBe(false);
    expect(presentCopyControlAck(applyCopyStop(follow), 'STOP_NEW').flattenInvented).toBe(false);
    expect(presentCopyControlAck(applyCopyDetach(follow), 'DETACH_KEEP').flattenInvented).toBe(false);
  });

  it('resume is only from pause; stop/detach cannot resume', () => {
    expect(applyCopyResume(applyCopyPause(follow)).relationshipState).toBe('ACTIVE');
    expect(() => applyCopyResume(applyCopyStop(follow))).toThrow(/STOPPING/);
    expect(() => applyCopyResume(applyCopyDetach(follow))).toThrow(/DETACHED/);
    expect(() => applyCopyPause(applyCopyDetach(follow))).toThrow(/DETACHED/);
  });

  it('a follow already left refuses every control by trade.copy_detached', () => {
    const detached = applyCopyDetach(follow);
    for (const apply of [applyCopyLeave, applyCopyPause, applyCopyResume, applyCopyStop, applyCopyStopCloseOnly]) {
      expect(() => apply(detached)).toThrow(expect.objectContaining({ code: 'trade.copy_detached' }));
    }
    expect(applyCopyLeave(follow)).toEqual(applyCopyDetach(follow));
  });
});
