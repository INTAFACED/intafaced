import path from 'node:path';
import { isExplicitDevOrTest } from '@intafaced/config';
import type { ChainSendLookup, ChainSendRequest, ConfirmedTransfer, CryptoChainPort } from './chain-port.js';
import { railRecorder, type RailRecorder } from './test-rail-records.js';

/**
 * LOCAL TEST: the TEST chain's own record of what it sent out of custody (J-ops-console-27 #7 and #8).
 *
 * On a dev or test stack, rail `crypto-native` sends through the in-process `MemoryChain`, which forgets everything on a
 * restart and is not a source anyone outside can read. `PAY_TEST_RAIL_RECORDS_DIR` (the stack sets it to its
 * `<state>/test-rail-records`) makes that chain keep its own TEST line for each transfer it sent, keyed by the send's
 * business key, so the stack's outside source can say what rail `crypto-native` holds in the chain's words, never by
 * reading the ledger back. Unset or blank, nothing is wrapped and nothing is written.
 *
 * The line is written after the chain sent and before the caller posts anything. A record that cannot be written throws,
 * which `CryptoNativeAdapter` treats as an unknown outcome: the withdrawal stays held, the retry asks `lookupSend`, and
 * the chain's "sent" answer writes the record then (the same key with the same facts is one record).
 *
 * The records outlive the in-memory chain: after a restart the chain has forgotten a send its record still holds. Such a
 * send is never sent again (it throws, so the caller keeps the hold), and a lookup that the forgetful chain answers
 * "not sent" is answered "unknown" instead, so nothing recorded as gone out is ever reversed back to the customer.
 *
 * Only a sandbox chain is wrapped: a live chain's own word is the chain, and an absent one sends nothing. Set in a process
 * whose raw `APP_ENV` is not exactly `dev` or `test`, under `NODE_ENV=production`, to a path that is not absolute, or
 * over any chain but a sandbox, the service refuses to start.
 */
export const PAY_TEST_RAIL_RECORDS_DIR_ENV = 'PAY_TEST_RAIL_RECORDS_DIR';

/** The rail the chain is the outside side of. */
export const RECORDED_CHAIN_RAIL = 'crypto-native';

export class RecordingChain implements CryptoChainPort {
  readonly posture: CryptoChainPort['posture'];
  readonly description: string;

  constructor(
    private readonly inner: CryptoChainPort,
    private readonly records: RailRecorder,
  ) {
    this.posture = inner.posture;
    this.description = `${inner.description}; keeps its TEST rail records`;
  }

  acceptanceAddress(paymentId: string, assetId: string): Promise<string> {
    return this.inner.acceptanceAddress(paymentId, assetId);
  }

  inboundTransfer(address: string): Promise<ConfirmedTransfer | null> {
    return this.inner.inboundTransfer(address);
  }

  inboundTransfers(address: string): Promise<readonly ConfirmedTransfer[]> {
    return this.inner.inboundTransfers(address);
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }

  /** The chain's own depth. A send only the records remember has none this chain can read: `null`, so it stays held. */
  sendDepth(idempotencyKey: string): Promise<number | null> {
    return this.inner.sendDepth(idempotencyKey);
  }

  async send(request: ChainSendRequest): Promise<{ txHash: string }> {
    const key = recordKey(request.idempotencyKey);
    if ((await this.inner.lookupSend(request.idempotencyKey)).state !== 'sent' && (await this.records.has(key))) {
      throw new Error(`${key} is recorded as sent before this chain's memory began; it is not sent again`);
    }
    const sent = await this.inner.send(request);
    await this.records.record(sentMovement(request.idempotencyKey, request.assetId, request.amount));
    return sent;
  }

  async lookupSend(idempotencyKey: string): Promise<ChainSendLookup> {
    const found = await this.inner.lookupSend(idempotencyKey);
    // A send the chain says left, found again after a record that was not written: it is written now.
    if (found.state === 'sent' && found.assetId !== null && found.amount !== null) {
      await this.records.record(sentMovement(idempotencyKey, found.assetId, found.amount));
    }
    // Recorded as gone out, but the chain restarted and forgot it: not "not sent", or the hold would be reversed.
    if (found.state === 'not_sent' && (await this.records.has(recordKey(idempotencyKey)))) return { state: 'unknown' };
    return found;
  }
}

const recordKey = (idempotencyKey: string) => `send:${idempotencyKey}`;

const sentMovement = (idempotencyKey: string, assetId: string, amount: bigint) => ({
  key: recordKey(idempotencyKey),
  direction: 'out' as const,
  assetId,
  amount,
});

/** Why the service will not start with this records folder. */
export class TestRailRecordsRefusedError extends Error {
  readonly code = 'pay.test_rail_records_refused';
  constructor(message: string) {
    super(message);
    this.name = 'TestRailRecordsRefusedError';
  }
}

/** The chain as it is, or wrapped to keep its TEST records when the stack names a folder. `env` is the RAW process env. */
export function recordingChainFor(chain: CryptoChainPort, env: Record<string, string | undefined> = process.env): CryptoChainPort {
  const dir = env[PAY_TEST_RAIL_RECORDS_DIR_ENV]?.trim();
  if (!dir) return chain;
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') {
    throw new TestRailRecordsRefusedError(
      `${PAY_TEST_RAIL_RECORDS_DIR_ENV} is the local-test stack's records folder; it is set only with APP_ENV exactly dev or test`,
    );
  }
  if (!path.isAbsolute(dir)) {
    throw new TestRailRecordsRefusedError(`${PAY_TEST_RAIL_RECORDS_DIR_ENV} must be an absolute path`);
  }
  if (chain.posture !== 'sandbox') {
    throw new TestRailRecordsRefusedError(
      `${PAY_TEST_RAIL_RECORDS_DIR_ENV} keeps records for the TEST chain only; this chain is ${chain.posture}`,
    );
  }
  return new RecordingChain(chain, railRecorder(dir, RECORDED_CHAIN_RAIL));
}
