import { describe, expect, it } from 'vitest';
import {
  assertLiveCredential,
  LiveCredentialError,
  type LiveCredentialInput,
  type LiveCredentialPort,
  type OwnershipSnapshot,
} from '../private/live-credential.js';
import { RecoveredMintKeyStreamError, recoveredMintKeyRevokeDropsStream } from '../private/recovery-mint-key-revoke-stream.js';
import { recoveryCodeOpensRecoveredDropCopyStream } from './recovery-open-recovered-stream.js';
import { RecoveredMintKeyDropCopyStreamError, recoveredMintKeyRevokeDropsDropCopyStream } from './recovery-mint-key-revoke-stream.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function port(key: OwnershipSnapshot | null | 'live' = 'live'): LiveCredentialPort {
  return {
    async getSession() {
      return { id: SESSION, userId: USER, revoked: false };
    },
    async getApiKey() {
      if (key === 'live') return { id: KEY, userId: USER, revoked: false };
      return key;
    },
  };
}

const input = { userId: USER, sessionId: SESSION, apiKeyId: KEY };

describe('recoveredMintKeyRevokeDropsDropCopyStream', () => {
  it('refuses while the recovered-session key is still live', async () => {
    await expect(recoveredMintKeyRevokeDropsDropCopyStream(port(), input)).rejects.toMatchObject({
      code: 'auth.api_key_live',
    });
  });

  it('allows the drop after that key is revoked', async () => {
    const revoked = port({ id: KEY, userId: USER, revoked: true });
    await expect(recoveredMintKeyRevokeDropsDropCopyStream(revoked, input)).resolves.toBeUndefined();
  });

  it('refuses a missing key', async () => {
    await expect(recoveredMintKeyRevokeDropsDropCopyStream(port(null), input)).rejects.toMatchObject({
      code: 'auth.api_key_denied',
    });
  });

  it('refuses a missing apiKeyId without inventing a session check', async () => {
    await expect(recoveredMintKeyRevokeDropsDropCopyStream(port(), { userId: USER, sessionId: SESSION })).rejects.toMatchObject({
      code: 'auth.api_key_denied',
    });
  });

  it('reuses assertLiveCredential: its refusals, a revoked key drops, a live key refuses; not a private-stream or drop-copy-open redo', async () => {
    // Every refusal but a revoked key is assertLiveCredential's own answer, on the same port and input.
    const viaLive = async (p: LiveCredentialPort, i: LiveCredentialInput) =>
      assertLiveCredential(p, i).then(
        () => 'live',
        (err: unknown) => (err instanceof LiveCredentialError ? err.code : String(err)),
      );
    const viaDoor = async (p: LiveCredentialPort, i: LiveCredentialInput) =>
      recoveredMintKeyRevokeDropsDropCopyStream(p, i).then(
        () => 'dropped',
        (err: unknown) =>
          err instanceof LiveCredentialError || err instanceof RecoveredMintKeyDropCopyStreamError ? err.code : String(err),
      );
    const otherOwner = port({ id: KEY, userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revoked: false });
    for (const p of [otherOwner, port(null)]) {
      const live = await viaLive(p, input);
      expect(live).not.toBe('live');
      expect(await viaDoor(p, input)).toBe(live);
    }
    expect(await viaLive(port({ id: KEY, userId: USER, revoked: true }), input)).toBe('auth.api_key_revoked');
    expect(await viaDoor(port({ id: KEY, userId: USER, revoked: true }), input)).toBe('dropped');
    expect(await viaDoor(port(), input)).toBe('auth.api_key_live');

    // It reads the key it was given (trimmed) through the port it was handed, and nothing else.
    const asked: string[] = [];
    const recording: LiveCredentialPort = {
      async getSession(id) {
        asked.push(`session:${id}`);
        return { id: SESSION, userId: USER, revoked: false };
      },
      async getApiKey(id) {
        asked.push(`key:${id}`);
        return { id: KEY, userId: USER, revoked: true };
      },
    };
    await expect(recoveredMintKeyRevokeDropsDropCopyStream(recording, { ...input, apiKeyId: ` ${KEY} ` })).resolves.toBeUndefined();
    expect(asked).toContain(`key:${KEY}`);
    expect(asked.every((a) => a === `key:${KEY}` || a === `session:${SESSION}`)).toBe(true);
    expect(recoveredMintKeyRevokeDropsDropCopyStream).not.toBe(recoveredMintKeyRevokeDropsStream);
    expect(RecoveredMintKeyDropCopyStreamError).not.toBe(RecoveredMintKeyStreamError);
    expect(recoveredMintKeyRevokeDropsDropCopyStream as unknown).not.toBe(recoveryCodeOpensRecoveredDropCopyStream);
  });
});
