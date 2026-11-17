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

function chain(): EvmLiveChain {
  return new EvmLiveChain({
    rpcUrl: 'http://127.0.0.1:9',
    chainId: 31337,
    deposits: TestnetDepositAddresses.fromFixturePhrase(MNEMONIC),
    signer: TestnetSigner.fromFixtureKey(HOT_KEY),
    assets: parseEvmAssets('ETH:native'),
    broadcasts: new MemoryBroadcastStore(),
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
  it('never answers not_sent for a send that has claimed its key and goes on to broadcast', async () => {
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
    await sending;
    expect(broadcasts).toBe(1);
    expect(during.state).not.toBe('not_sent');
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
