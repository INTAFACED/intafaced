import { decodeFunctionData, encodeFunctionData, hashMessage, recoverAddress, getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import { accountFactoryAbi, smartAccountAbi } from '../chain/abi.js';
import { ProtocolChain } from '../chain/client.js';
import { decodeSignatureEnvelope, getUserOperationHash, type UserOperation } from '../chain/userop.js';
import { hashSessionSpec, type SessionSpec } from './spec.js';
import { redactRpcUrl, redactSecrets } from '../chain/availability.js';
import { withAuthoritySpan } from '../tracing.js';

/**
 * RELAY — the service constructs and forwards; it never authorises.
 *
 * This is the file where a custodial platform would keep a signing key. There
 * isn't one. Every function here does exactly one of two things:
 *
 *   · BUILD — turn an intent into unsigned calldata for the user to sign. The
 *     output is bytes, not a transaction. Nothing has happened yet.
 *   · FORWARD — take an operation the user already signed, verify independently
 *     that the signature is the account owner's (or a live session key the owner
 *     granted), and hand it to a public bundler.
 *
 * The verification before forwarding is not a security control for the user —
 * the account would reject a bad signature anyway. It is a control on US: it is
 * the line of code that makes "the service never originates anything" checkable
 * rather than merely stated. If it is ever removed, the relay becomes a thing
 * that submits operations of unknown provenance, and that is a different
 * service with different doctrine.
 */

export type RelayRefusalCode =
  | 'relay.unsupported_signature_mode'
  | 'relay.signature_not_owner'
  | 'relay.session_unknown'
  | 'relay.session_not_live'
  | 'relay.session_spec_mismatch'
  | 'relay.session_key_mismatch'
  | 'relay.session_must_use_guarded_entry'
  | 'relay.sender_mismatch'
  | 'relay.bundler_unavailable'
  | 'relay.bundler_rejected';

export class RelayRefusedError extends Error {
  constructor(
    readonly code: RelayRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayRefusedError';
  }
}

export interface UnsignedCall {
  /** The contract the user's own signature will authorise a call to. */
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  /** What this call means, in one line, for a signing prompt. */
  readonly summary: string;
}

/** Whose key backed a relayed operation. There is no third value. */
export type Authority = 'owner' | 'session';

export interface RelayVerification {
  readonly authority: Authority;
  readonly signer: Address;
  readonly userOpHash: Hex;
}

export class SessionRelay {
  constructor(private readonly chain: ProtocolChain) {}

  // ── Build (nothing has happened yet) ──────────────────────────────────────

  /** Deploy an account. Permissionless: the owner is bound into the address. */
  buildDeployment(owner: Address, userSalt: Hex): UnsignedCall {
    return {
      to: this.chain.config.factory,
      data: encodeFunctionData({
        abi: accountFactoryAbi,
        functionName: 'createAccount',
        args: [owner, userSalt],
      }),
      value: 0n,
      summary: `Deploy the smart account owned by ${owner}`,
    };
  }

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

  // ── Forward (only what the user signed) ───────────────────────────────────

  /**
   * Independently establish who signed this operation, before it is forwarded.
   *
   * Refuses rather than reporting: an operation whose provenance we cannot
   * prove does not get relayed by us. Somebody else's bundler may still accept
   * it — that is fine and rather the point of a permissionless system — but it
   * will not have travelled through here.
   */
  async verify(userOp: UserOperation, account: Address): Promise<RelayVerification> {
    return withAuthoritySpan('relay.verify', { operation: 'verify', account }, async (span) => {
      if (toChecksum(userOp.sender) !== toChecksum(account)) {
        throw new RelayRefusedError('relay.sender_mismatch', 'The operation sender is not the account it claims');
      }

      const userOpHash = getUserOperationHash({
        userOp,
        entryPoint: this.chain.config.entryPoint,
        chainId: this.chain.config.chainId,
      });
      // SmartAccount validates over the EIP-191 personal-sign digest, so the
      // relay must recover over exactly the same bytes.
      const digest = hashMessage({ raw: userOpHash });
      const { mode, signature } = decodeSignatureEnvelope(userOp.signature);

      if (mode === 'owner') {
        const owner = await this.chain.ownerOf(account);
        const recovered = await recoverAddress({ hash: digest, signature });
        if (toChecksum(recovered) !== toChecksum(owner)) {
          // A contract owner (a passkey verifier) does not recover to an
          // address; that path answers ERC-1271 and lands with the verifier.
          // SOCKET: §13 `socket.p256-verifier`.
          throw new RelayRefusedError('relay.signature_not_owner', 'Signature does not belong to the account owner');
        }
        span.setAttribute('intafaced.authority', 'owner');
        return { authority: 'owner' as const, signer: toChecksum(recovered), userOpHash };
      }

      const signer = toChecksum(await recoverAddress({ hash: digest, signature }));

      const record = await this.chain.sessionOf(account, signer);
      if (!record) {
        throw new RelayRefusedError('relay.session_unknown', `${signer} holds no session on this account`);
      }
      if (!(await this.chain.isSessionLive(account, signer))) {
        throw new RelayRefusedError('relay.session_not_live', `Session ${signer} is revoked, stale, or expired`);
      }

      // A session operation must route through the guarded entry — the same
      // rule SmartAccount._validateSignature enforces. Checked here too so a
      // refusal is a clear error rather than an opaque on-chain revert.
      const decoded = this.#decodeSessionCall(userOp.callData);
      if (!decoded) {
        throw new RelayRefusedError('relay.session_must_use_guarded_entry', 'A session-signed operation must call executeWithSession');
      }
      if (toChecksum(decoded.key) !== signer) {
        throw new RelayRefusedError('relay.session_key_mismatch', 'The operation names a different session key');
      }
      if (decoded.specHash.toLowerCase() !== record.specHash.toLowerCase()) {
        throw new RelayRefusedError('relay.session_spec_mismatch', 'The presented scope is not the scope this session was granted');
      }

      span.setAttribute('intafaced.authority', 'session');
      return { authority: 'session' as const, signer, userOpHash };
    });
  }

  #decodeSessionCall(callData: Hex): { key: Address; specHash: Hex } | null {
    try {
      const decoded = decodeFunctionData({ abi: smartAccountAbi, data: callData });
      if (decoded.functionName !== 'executeWithSession') return null;
      const spec = decoded.args[0];
      return {
        key: spec.key,
        specHash: hashSessionSpec({
          key: spec.key,
          validAfter: Number(spec.validAfter),
          validUntil: Number(spec.validUntil),
          spendLimitWei: spec.spendLimitWei,
          targets: [...spec.targets],
          selectors: [...spec.selectors],
        }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify, then hand to a public bundler. The bundler is a commodity: it
   * cannot alter the operation, because the signature covers everything except
   * itself.
   */
  async submit(userOp: UserOperation, account: Address): Promise<{ userOpHash: Hex; authority: Authority }> {
    const verification = await this.verify(userOp, account);

    const bundlerUrl = this.chain.config.bundlerUrl;
    if (!bundlerUrl) {
      throw new RelayRefusedError('relay.bundler_unavailable', 'No bundler configured — the user may submit this operation themselves');
    }

    return withAuthoritySpan('relay.submit', { operation: 'submit', account, authority: verification.authority }, async () => {
      let response: Response;
      try {
        response = await fetch(bundlerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendUserOperation',
            params: [serializeUserOperation(userOp), this.chain.config.entryPoint],
          }),
        });
      } catch (err) {
        const detail = redactSecrets(err instanceof Error ? err.message : String(err), bundlerUrl);
        console.error(`svc-protocol chain refusal code=relay.bundler_unavailable detail=bundler ${redactRpcUrl(bundlerUrl)} ${detail}`);
        throw new RelayRefusedError('relay.bundler_unavailable', 'The chain connection is not available right now.');
      }
      const body = (await response.json()) as { result?: Hex; error?: { message?: string } };
      if (!response.ok || body.error) {
        const raw = body.error?.message ?? `Bundler HTTP ${response.status}`;
        const safe = redactSecrets(raw, bundlerUrl);
        const leaked = safe !== raw || raw.includes(bundlerUrl) || /:\/\//.test(raw);
        throw new RelayRefusedError('relay.bundler_rejected', leaked ? 'The bundler rejected the operation.' : raw);
      }
      return { userOpHash: body.result ?? verification.userOpHash, authority: verification.authority };
    });
  }
}

/** Bundler JSON-RPC wants hex quantities, not bigints. */
export function serializeUserOperation(op: UserOperation): Record<string, string | undefined> {
  const hex = (v: bigint) => `0x${v.toString(16)}`;
  return {
    sender: op.sender,
    nonce: hex(op.nonce),
    factory: op.factory,
    factoryData: op.factoryData,
    callData: op.callData,
    callGasLimit: hex(op.callGasLimit),
    verificationGasLimit: hex(op.verificationGasLimit),
    preVerificationGas: hex(op.preVerificationGas),
    maxFeePerGas: hex(op.maxFeePerGas),
    maxPriorityFeePerGas: hex(op.maxPriorityFeePerGas),
    paymaster: op.paymaster,
    paymasterVerificationGasLimit: op.paymasterVerificationGasLimit === undefined ? undefined : hex(op.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: op.paymasterPostOpGasLimit === undefined ? undefined : hex(op.paymasterPostOpGasLimit),
    paymasterData: op.paymasterData,
    signature: op.signature,
  };
}
