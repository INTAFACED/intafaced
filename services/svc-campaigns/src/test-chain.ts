import type { RewardChain } from './reward-payer.js';

/**
 * The LOCAL TEST chain's reward payer (J-campaigns-03): our TEST rewards wallet on the stack's anvil. That wallet has no
 * key; anvil sends for it (`anvil_impersonateAccount`), as the stack's TEST venue pays its withdrawals. So this works on a
 * loopback anvil only, and refuses anything else by name: a real chain needs the owner's own signing key, which nothing
 * here holds (AGENTS.md floor 7). Plain JSON-RPC, read straight from the chain.
 */

const BALANCE_OF = '0x70a08231';
const TRANSFER = '0xa9059cbb';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const topicOf = (address: string) => `0x${word(address)}`;

export function testRewardChain(opts: { rpcUrl: string; token: string; chainId: number }): RewardChain {
  const url = new URL(opts.rpcUrl);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`the TEST reward payer pays on a loopback chain only, not ${opts.rpcUrl}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.token)) throw new Error('the TEST reward token must be a 0x address');
  const token = opts.token.toLowerCase();
  let id = 0;
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const res = await fetch(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? 'refused'}`);
    return body.result as T;
  };
  const ready = new Set<string>();
  /** The node must be the stack's anvil on the stack's chain before our wallet sends there; checked once per wallet. */
  const prepare = async (from: string) => {
    if (ready.has(from)) return;
    const chainId = Number(BigInt(await rpc<string>('eth_chainId', [])));
    if (chainId !== opts.chainId) throw new Error(`the TEST chain is chain ${chainId}, not ${opts.chainId}`);
    const version = await rpc<string>('web3_clientVersion', []);
    if (!/anvil/i.test(version)) throw new Error(`the TEST reward payer pays from an impersonated wallet on anvil only, not ${version}`);
    await rpc('anvil_impersonateAccount', [from]);
    // Network gas in TEST ETH, which anvil gives the impersonated wallet.
    await rpc('anvil_setBalance', [from, `0x${(10n ** 20n).toString(16)}`]);
    ready.add(from);
  };
  return {
    head: async () => BigInt(await rpc<string>('eth_blockNumber', [])),
    holds: async (from) => BigInt(await rpc<string>('eth_call', [{ to: token, data: `${BALANCE_OF}${word(from)}` }, 'latest'])),
    async send(from, to, units) {
      await prepare(from);
      return rpc<string>('eth_sendTransaction', [{ from, to: token, data: `${TRANSFER}${word(to)}${word(units.toString(16))}` }]);
    },
    async receipt(hash) {
      const r = await rpc<{ status?: string } | null>('eth_getTransactionReceipt', [hash]);
      if (!r) return null;
      return r.status === '0x1';
    },
    async find(from, to, units, fromBlock) {
      const logs = await rpc<{ data: string; transactionHash?: string; removed?: boolean }[]>('eth_getLogs', [
        { address: token, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: 'latest', topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)] },
      ]);
      return logs.filter((l) => !l.removed && l.transactionHash && BigInt(l.data) === units).map((l) => l.transactionHash!);
    },
  };
}

/** The ledger's platform posting freeze, read from svc-ledger's public `/health`: null when it could not be read. */
export function ledgerPostingEnabled(ledgerUrl: string): () => Promise<boolean | null> {
  return async () => {
    try {
      const res = await fetch(new URL('/health', ledgerUrl), { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { postingEnabled?: unknown };
      return typeof body.postingEnabled === 'boolean' ? body.postingEnabled : null;
    } catch {
      return null;
    }
  };
}
