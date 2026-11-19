import { encodeFunctionData } from 'viem';
import type { Address, Hex } from 'viem';
import { smartAccountAbi } from '../chain/abi.js';
import { hashSessionSpec, type SessionSpec } from './spec.js';

/**
 * RELAY — the service builds; it never authorises and never forwards.
 *
 * This is the file where a custodial platform would keep a signing key. There
 * isn't one. Every function here turns an intent into unsigned calldata for the
 * user to sign. The output is bytes, not a transaction. Nothing has happened yet.
 */

export interface UnsignedCall {
  /** The contract the user's own signature will authorise a call to. */
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** What this call means, in one line, for a signing prompt. */
  readonly summary: string;
}

export class SessionRelay {
  // ── Build (nothing has happened yet) ──────────────────────────────────────

  /**
   * Grant a session. The spec must already have passed `createSessionSpec` —
   * this function builds bytes and asks no further questions, because the one
   * place scope is decided is `session/spec.ts` and the contract.
   */
  buildSessionGrant(account: Address, spec: SessionSpec): UnsignedCall & { specHash: Hex } {
    return {
      to: account,
      data: encodeFunctionData({
        abi: smartAccountAbi,
        functionName: 'grantSession',
        args: [
          {
            key: spec.key,
            validAfter: spec.validAfter,
            validUntil: spec.validUntil,
            spendLimitWei: spec.spendLimitWei,
            targets: [...spec.targets],
            selectors: [...spec.selectors],
          },
        ],
      }),
      value: 0n,
      specHash: hashSessionSpec(spec),
      summary:
        `Grant ${spec.key} permission to call ${spec.targets.length} contract(s) ` +
        `until ${new Date(spec.validUntil * 1000).toISOString()}, spending at most ${spec.spendLimitWei} wei`,
    };
  }

  buildSessionRevoke(account: Address, sessionKey: Address): UnsignedCall {
    return {
      to: account,
      data: encodeFunctionData({ abi: smartAccountAbi, functionName: 'revokeSession', args: [sessionKey] }),
      value: 0n,
      summary: `Revoke session key ${sessionKey}`,
    };
  }

  /** The user's panic button: every outstanding session dies at once. */
  buildRevokeAllSessions(account: Address): UnsignedCall {
    return {
      to: account,
      data: encodeFunctionData({ abi: smartAccountAbi, functionName: 'bumpSessionEpoch' }),
      value: 0n,
      summary: 'Revoke every session key on this account',
    };
  }
}
