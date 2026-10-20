import { describe, expect, it } from 'vitest';
import { readDeskRequest } from '@/lib/desk/approval-packet';
import { readKeyState, removalIds, rotationCandidates } from './keys-model';

const state = {
  activeKeyId: 'k2',
  previousKeyIds: ['legacy', 'k1'],
  activatedAt: '2026-10-20T10:00:00.000Z',
  nextRemoval: ['legacy', 'k1'],
  availableKeyIds: ['legacy', 'k1', 'k2', 'k3'],
};

describe('key state reader', () => {
  it('reads exactly the service shape and drops nothing it needs', () => {
    expect(readKeyState(state)).toEqual({
      activeKeyId: 'k2',
      previousKeyIds: ['legacy', 'k1'],
      activatedAt: '2026-10-20T10:00:00.000Z',
      availableKeyIds: ['legacy', 'k1', 'k2', 'k3'],
    });
  });
  it('refuses a wrong type instead of guessing', () => {
    expect(readKeyState({ ...state, activeKeyId: 1 })).toBeNull();
    expect(readKeyState({ ...state, previousKeyIds: 'k1' })).toBeNull();
    expect(readKeyState({ ...state, nextRemoval: 'k1' })).toBeNull();
    expect(readKeyState(null)).toBeNull();
  });
  it('offers only ids not in use, and names removal ids sorted', () => {
    const s = readKeyState(state)!;
    expect(rotationCandidates(s)).toEqual(['k3']);
    expect(removalIds(s)).toBe('k1,legacy');
    expect(removalIds({ ...s, previousKeyIds: [] })).toBeNull();
  });
});

describe('key requests', () => {
  it('accept a valid id and refuse legacy, bad ids and unsorted lists', () => {
    expect(readDeskRequest({ kind: 'identity.auth_key.rotate', keyId: 'k3' })).toEqual({ kind: 'identity.auth_key.rotate', keyId: 'k3' });
    expect(readDeskRequest({ kind: 'identity.auth_key.rotate', keyId: 'legacy' })).toBeNull();
    expect(readDeskRequest({ kind: 'identity.auth_key.rotate', keyId: 'K3' })).toBeNull();
    expect(readDeskRequest({ kind: 'identity.auth_key.rotate', keyId: 'k3', extra: 1 })).toBeNull();
    expect(readDeskRequest({ kind: 'identity.auth_key.remove_old', keyIds: 'k1,legacy' })).not.toBeNull();
    expect(readDeskRequest({ kind: 'identity.auth_key.remove_old', keyIds: 'legacy,k1' })).toBeNull();
    expect(readDeskRequest({ kind: 'identity.auth_key.remove_old', keyIds: '' })).toBeNull();
  });
});
