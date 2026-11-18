import { parseAmount } from '@intafaced/ledger-client';
import { TestnetDepositAddresses } from './deposit-source.js';
import { TestnetSigner } from './evm-signer.js';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { MemoryBroadcastStore } from './broadcast-store.js';
import { parseEvmAssets } from './evm-assets.js';
import { EvmLiveChain, EvmSendRevertedError } from './evm-chain.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const HOT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TX = `0x${'ab'.repeat(32)}` as Hex;
/** Above viem's one-block default, so a missed `confirmations` argument fails this test. */
const DEPTH = 4;

const DEST = privateKeyToAccount(HOT_KEY).address;

function chain(broadcasts = new MemoryBroadcastStore()): EvmLiveChain {
  return new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:9',
    chainId: 31337,
    deposits: TestnetDepositAddresses.fromFixturePhrase(MNEMONIC),
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts,
    minConfirmations: DEPTH,
    requestTimeoutMs: 500,
  });
}

interface SendClients {
  public: {
    sendRawTransaction: (args: { serializedTransaction: Hex }) => Promise<Hex>;
    waitForTransactionReceipt: (args: { hash: Hex; confirmations?: number }) => Promise<{ status: string }>;
  };
  wallet: {
    prepareTransactionRequest: (args: object) => Promise<Record<string, unknown>>;
    signTransaction: (args: object) => Promise<Hex>;
  };
}

function clients(port: EvmLiveChain): SendClients {
  return port as unknown as SendClients;
}

function stubBroadcast(port: EvmLiveChain, status: string): Array<{ hash: string; confirmations: number | undefined }> {
  const seen: Array<{ hash: string; confirmations: number | undefined }> = [];
  const surface = clients(port);
  surface.wallet.prepareTransactionRequest = async () => ({});
  surface.wallet.signTransaction = async () => '0x02' as Hex;
  surface.public.sendRawTransaction = async () => TX;
  surface.public.waitForTransactionReceipt = async (args) => {
    seen.push({ hash: args.hash, confirmations: args.confirmations });
    return { status };
  };
  return seen;
}

const sendRequest = {
  to: DEST,
  assetId: 'ETH',
  amount: parseAmount('1.25'),
  idempotencyKey: 'l319-send',
};

describe('EvmLiveChain send receipt', () => {
  it('passes a configured depth above one to the wait and returns the stored hash on success', async () => {
    const port = chain();
    const seen = stubBroadcast(port, 'success');
    const result = await port.send({ ...sendRequest, idempotencyKey: 'l319-success' });

    expect(DEPTH).toBeGreaterThan(1);
    expect(seen).toEqual([{ hash: TX, confirmations: DEPTH }]);
    expect(result).toEqual({ txHash: TX });
    expect(typeof sendRequest.amount).toBe('bigint');
  });

  it('refuses a reverted receipt and does not return that hash as success', async () => {
    const port = chain();
    const seen = stubBroadcast(port, 'reverted');

    const outcome = port.send({ ...sendRequest, idempotencyKey: 'l319-reverted' });
    await expect(outcome).rejects.toBeInstanceOf(EvmSendRevertedError);
    await expect(outcome).rejects.toMatchObject({
      name: 'EvmSendRevertedError',
      code: 'pay.evm_send_reverted',
      txHash: TX,
      status: 'reverted',
    });
    expect(seen).toEqual([{ hash: TX, confirmations: DEPTH }]);
  });
});

// PayoutQuery.tla (services/svc-pay/model), NeverPaidTwice: a reconciler that hears `not_sent` reverses the held payout, so `not_sent`
// must be proof the send can no longer leave. A send that has claimed its key and is still signing can.
describe('EvmLiveChain lookupSend while a send is on its way', () => {
  // The payer claims the key and is signing; the reconciler asks. A not_sent answer must close the key, so the send
  // fails at putSigned and nothing leaves: a not_sent that let the send go on would mean paid and given back.
  it('never both answers not_sent and broadcasts, for a query that comes while the send is signing', async () => {
    const port = chain();
    stubBroadcast(port, 'success');
    const surface = clients(port);
    let reached!: () => void;
    const signing = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const signed = new Promise<void>((resolve) => (release = resolve));
    surface.wallet.signTransaction = async () => {
      reached();
      await signed;
      return '0x02' as Hex;
    };
    let broadcasts = 0;
    surface.public.sendRawTransaction = async () => {
      broadcasts += 1;
      return TX;
    };
    const key = 'payout-query-while-signing';
    const sending = port.send({ ...sendRequest, idempotencyKey: key });
    await signing;
    // The status query a reconciler makes while the send is signing (a remote signer can take seconds).
    const during = await port.lookupSend(key);
    release();
    const sent = await sending.then(
      () => 'sent',
      (err: unknown) => err,
    );
    expect(during.state).toBe('not_sent');
    expect(sent).toBeInstanceOf(Error);
    expect(String(sent)).toMatch(/closed by a not_sent answer/);
    expect(broadcasts).toBe(0);
  });

  it('answers unknown, never not_sent, once the send has journalled its signed bytes', async () => {
    const port = chain();
    stubBroadcast(port, 'success');
    const surface = clients(port);
    let reached!: () => void;
    const broadcasting = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const answered = new Promise<void>((resolve) => (release = resolve));
    let broadcasts = 0;
    surface.public.sendRawTransaction = async () => {
      broadcasts += 1;
      reached();
      await answered;
      return TX;
    };
    const key = 'payout-query-while-broadcasting';
    const sending = port.send({ ...sendRequest, idempotencyKey: key });
    await broadcasting;
    const during = await port.lookupSend(key);
    release();
    await sending;
    expect(during.state).toBe('unknown');
    expect(broadcasts).toBe(1);
  });

  // The send claims its key and its signer throws (or the process dies) before anything is journalled. The claim must
  // not stay pending forever with every query answering unknown and the hold stuck.
  it('a send whose signer failed before anything was journalled can still be answered not_sent', async () => {
    const port = chain();
    stubBroadcast(port, 'success');
    const surface = clients(port);
    let broadcasts = 0;
    surface.wallet.signTransaction = async () => {
      throw new Error('remote signer timed out');
    };
    surface.public.sendRawTransaction = async () => {
      broadcasts += 1;
      return TX;
    };
    const key = 'payout-signer-failed';
    await expect(port.send({ ...sendRequest, idempotencyKey: key })).rejects.toThrow(/timed out/);
    expect(broadcasts).toBe(0);
    expect((await port.lookupSend(key)).state).toBe('not_sent');
    // The retry of the payout, after its money was given back on that answer, sends nothing.
    await expect(port.send({ ...sendRequest, idempotencyKey: key })).rejects.toThrow(/closed/);
    expect(broadcasts).toBe(0);
  });

  it('never sends under a key it has already answered not_sent for', async () => {
    const port = chain();
    stubBroadcast(port, 'success');
    let broadcasts = 0;
    clients(port).public.sendRawTransaction = async () => {
      broadcasts += 1;
      return TX;
    };
    const key = 'payout-answered-not-sent';
    // The reconciler's query comes after the payout's 'dispatched' marker and before its send reached the chain port.
    const answered = await port.lookupSend(key);
    expect(answered.state).toBe('not_sent');
    // The reconciler gives the held money back on that answer; the payer's send then arrives under the same key.
    await port.send({ ...sendRequest, idempotencyKey: key }).catch(() => undefined);
    expect(broadcasts).toBe(0);
  });
});

describe('EvmLiveChain sendDepth', () => {
  async function depthFor(status: string | null, blockNumber = 5n, tip = 10n): Promise<unknown> {
    const broadcasts = new MemoryBroadcastStore();
    await broadcasts.claim('depth-key');
    await broadcasts.put('depth-key', TX);
    const port = chain(broadcasts);
    const surface = Reflect.get(port, 'public') as {
      getTransactionReceipt: (args: { hash: Hex }) => Promise<object | null>;
      getBlockNumber: () => Promise<bigint>;
    };
    surface.getTransactionReceipt = async ({ hash }) => (status === null || hash !== TX ? null : { status, blockNumber });
    surface.getBlockNumber = async () => tip;
    return port.sendDepth('depth-key');
  }

  it('reads a mined success as its depth, and no receipt yet as 0', async () => {
    expect(await depthFor('success')).toBe(6);
    expect(await depthFor(null)).toBe(0);
  });

  it('tells a reverted receipt apart, with its own depth, so it never counts as confirmed', async () => {
    expect(await depthFor('reverted')).toEqual({ reverted: true, depth: 6 });
    expect(await depthFor('reverted', 10n, 10n)).toEqual({ reverted: true, depth: 1 });
  });
});
