import { getAbiItem, getAddress as toChecksum } from 'viem';
import type { Address, Hex } from 'viem';
import type { EventBus } from '@intafaced/events';
import { accountFactoryAbi, smartAccountAbi } from './chain/abi.js';
import type { ProtocolChain } from './chain/client.js';
import type { AccountRegistry } from './accounts/registry.js';
import { withSpan } from './tracing.js';

/**
 * CHAIN → BUS. Observation, not authorship.
 *
 * This service publishes only what it has watched happen on chain. It never
 * publishes an intent, a pending action, or anything it caused, because it does
 * not cause anything on this plane — the user's signature does.
 *
 * SOCKET §13 (`indexer.readmodels`): chain indexing belongs in svc-indexer, and
 * moves there when that feature lands. This observer is a narrow stand-in — one
 * factory address plus two account event topics — so smart accounts are usable
 * before the indexer exists, rather than a half-built one being left behind.
 */

const accountCreatedEvent = getAbiItem({ abi: accountFactoryAbi, name: 'AccountCreated' });
const sessionGrantedEvent = getAbiItem({ abi: smartAccountAbi, name: 'SessionGranted' });
const sessionRevokedEvent = getAbiItem({ abi: smartAccountAbi, name: 'SessionRevoked' });

const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

export interface ObserverDeps {
  chain: ProtocolChain;
  bus: EventBus;
  registry: AccountRegistry;
  /** Poll cadence. Chain events are not latency-critical here. */
  pollingIntervalMs?: number;
  onError?: (err: unknown, context: string) => void;
}

export class ChainObserver {
  #stoppers: Array<() => void> = [];

  constructor(private readonly deps: ObserverDeps) {}

  start(): void {
    const { chain, pollingIntervalMs = 4_000 } = this.deps;

    this.#stoppers.push(
      chain.client.watchEvent({
        address: chain.config.factory,
        event: accountCreatedEvent,
        pollingInterval: pollingIntervalMs,
        onLogs: (logs) => void this.#onAccountCreated(logs),
        onError: (err) => this.deps.onError?.(err, 'AccountCreated'),
      }),
    );

    // Accounts appear after this watch starts, so there is no address list.
    // The handler publishes only when ownerOfRecord shows log.address is a
    // row recordDeployment has marked deployed.
    this.#stoppers.push(
      chain.client.watchEvent({
        event: sessionGrantedEvent,
        pollingInterval: pollingIntervalMs,
        onLogs: (logs) => void this.#onSessionGranted(logs),
        onError: (err) => this.deps.onError?.(err, 'SessionGranted'),
      }),
    );

    this.#stoppers.push(
      chain.client.watchEvent({
        event: sessionRevokedEvent,
        pollingInterval: pollingIntervalMs,
        onLogs: (logs) => void this.#onSessionRevoked(logs),
        onError: (err) => this.deps.onError?.(err, 'SessionRevoked'),
      }),
    );
  }

  stop(): void {
    for (const stop of this.#stoppers) stop();
    this.#stoppers = [];
  }

  /**
   * A factory deployment is a registry row `recordDeployment` has marked
   * deployed. A missing row, or a row that is still undeployed, is not one.
   */
  async #isRecordedFactoryDeployment(address: Address): Promise<boolean> {
    const record = await this.deps.registry.ownerOfRecord(address);
    return record?.deployed === true;
  }

  async #onAccountCreated(logs: readonly { args: Record<string, unknown>; transactionHash: Hex | null }[]) {
    for (const log of logs) {
      const account = log.args.account as Address | undefined;
      const owner = log.args.owner as Address | undefined;
      const userSalt = log.args.userSalt as Hex | undefined;
      if (!account || !owner || !userSalt) continue;

      await withSpan('observer.accountCreated', async () => {
        await this.deps.registry.recordDeployment(account);
        const record = await this.deps.registry.ownerOfRecord(account);
        await this.deps.bus.publish(
          'protocolAccountCreated',
          {
            chainId: this.deps.chain.config.chainId,
            account: toChecksum(account),
            owner: toChecksum(owner),
            userSalt,
            txHash: log.transactionHash ?? ZERO_HASH,
            ...(record?.userId ? { userId: record.userId } : {}),
          },
          // A business key, not a random one: a re-delivery finds the original.
          { idempotencyKey: `protocol.account:${this.deps.chain.config.chainId}:${account.toLowerCase()}` },
        );
      }).catch((err) => this.deps.onError?.(err, 'AccountCreated'));
    }
  }

  async #onSessionGranted(logs: readonly { args: Record<string, unknown>; address: Address; transactionHash: Hex | null }[]) {
    for (const log of logs) {
      const sessionKey = log.args.sessionKey as Address | undefined;
      const specHash = log.args.specHash as Hex | undefined;
      if (!sessionKey || !specHash) continue;

      await withSpan('observer.sessionGranted', async () => {
        if (!(await this.#isRecordedFactoryDeployment(log.address))) return;
        await this.deps.bus.publish(
          'protocolSessionKeyCreated',
          {
            chainId: this.deps.chain.config.chainId,
            account: toChecksum(log.address),
            sessionKey: toChecksum(sessionKey),
            specHash,
            validAfter: Number(log.args.validAfter ?? 0),
            validUntil: Number(log.args.validUntil ?? 0),
            spendLimitWei: String(log.args.spendLimitWei ?? 0n),
            targets: ((log.args.targets ?? []) as Address[]).map((t) => toChecksum(t)),
            selectors: ((log.args.selectors ?? []) as Hex[]).map((s) => s.toLowerCase()),
            txHash: log.transactionHash ?? ZERO_HASH,
          },
          { idempotencyKey: `protocol.session:${log.address.toLowerCase()}:${specHash}` },
        );
      }).catch((err) => this.deps.onError?.(err, 'SessionGranted'));
    }
  }

  async #onSessionRevoked(logs: readonly { args: Record<string, unknown>; address: Address; transactionHash: Hex | null }[]) {
    for (const log of logs) {
      const sessionKey = log.args.sessionKey as Address | undefined;
      const revokedBy = log.args.revokedBy as Address | undefined;
      if (!sessionKey || !revokedBy) continue;

      await withSpan('observer.sessionRevoked', async () => {
        if (!(await this.#isRecordedFactoryDeployment(log.address))) return;
        await this.deps.bus.publish(
          'protocolSessionKeyCancelled',
          {
            chainId: this.deps.chain.config.chainId,
            account: toChecksum(log.address),
            sessionKey: toChecksum(sessionKey),
            revokedBy: toChecksum(revokedBy),
            txHash: log.transactionHash ?? ZERO_HASH,
          },
          {
            idempotencyKey: `protocol.session.revoked:${log.address.toLowerCase()}:${sessionKey.toLowerCase()}`,
          },
        );
      }).catch((err) => this.deps.onError?.(err, 'SessionRevoked'));
    }
  }
}
