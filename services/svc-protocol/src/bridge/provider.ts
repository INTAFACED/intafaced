import { isExplicitDevOrTest } from '@intafaced/config';
import { createPublicClient, getAddress, http, isHex, type Address, type Hex, type PublicClient } from 'viem';
import { z } from 'zod';
import { BRIDGE_TOKEN_ABI, BURNED_EVENT, lowerHex, type Attestation, type BridgeChain, type BridgeProvider } from './transfers.js';

/**
 * The bridge provider the transfers run on (D-bridge-chain-03). Which provider carries a route is the owner's decision,
 * and none is chosen, so in production this is null and every transfer refuses `bridge.provider_unset`.
 *
 * The one provider today is the labelled TEST stand-in on the local and test stacks: the TEST burn-and-mint token on the
 * stack's two TEST chains and the stack's TEST attester (tooling/scripts/local-test-chain.mjs). It is read only with
 * `PROTOCOL_BRIDGE_ROUTES=TEST` on a stack whose raw APP_ENV is `dev` or `test`, and every URL it names must be loopback.
 *
 *   PROTOCOL_BRIDGE_TOKEN_ADDRESS   the TEST bridge token, at the same address on every route chain
 *   PROTOCOL_BRIDGE_RPC_URLS        JSON {"<chainId>": "<rpc url>"} for every route chain
 *   PROTOCOL_BRIDGE_ATTESTER_URL    the TEST attester: GET ?chainId=<source>&tx=<burn hash>
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ATTESTER_TIMEOUT_MS = 5_000;
const ATTESTER_ANSWER = z.object({ status: z.string(), attestation: z.string().optional() });
const RPC_URLS = z.record(z.string().regex(/^\d{1,12}$/), z.string());

function chainReader(client: Pick<PublicClient, 'readContract' | 'getLogs' | 'getTransaction' | 'getTransactionReceipt'>): BridgeChain {
  return {
    burned: (token, intentId) => client.readContract({ address: token, abi: BRIDGE_TOKEN_ABI, functionName: 'burned', args: [intentId] }),
    minted: (token, intentId) => client.readContract({ address: token, abi: BRIDGE_TOKEN_ABI, functionName: 'minted', args: [intentId] }),
    async burnTx(token, intentId) {
      const logs = await client.getLogs({ address: token, event: BURNED_EVENT, args: { intentId }, fromBlock: 0n, toBlock: 'latest' });
      const hash = logs[0]?.transactionHash;
      return hash ? lowerHex(hash) : null;
    },
    async transaction(hash) {
      let tx;
      try {
        tx = await client.getTransaction({ hash });
      } catch (err) {
        if (err instanceof Error && err.name === 'TransactionNotFoundError') return null;
        throw err;
      }
      let status: 'pending' | 'success' | 'reverted' = 'pending';
      if (tx.blockNumber !== null) {
        const receipt = await client.getTransactionReceipt({ hash });
        status = receipt.status === 'success' ? 'success' : 'reverted';
      }
      return { from: tx.from, to: tx.to, input: tx.input, status };
    },
  };
}

async function fetchAttestation(url: string, sourceChainId: number, burnTx: Hex): Promise<Attestation> {
  const target = new URL(url);
  target.searchParams.set('chainId', String(sourceChainId));
  target.searchParams.set('tx', burnTx);
  const res = await fetch(target, { signal: AbortSignal.timeout(ATTESTER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the attester answered ${res.status}`);
  const body = ATTESTER_ANSWER.safeParse(await res.json());
  if (!body.success) throw new Error('the attester answered no attestation');
  if (body.data.status === 'pending') return { status: 'pending' };
  const attestation = body.data.attestation;
  if (body.data.status === 'ready' && attestation !== undefined && isHex(attestation) && attestation.length === 132)
    return { status: 'ready', attestation };
  throw new Error('the attester answered no attestation');
}

function loopback(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL. Refusing to boot.`);
  }
  if (!LOOPBACK.has(url.hostname)) throw new Error(`${name} must be a loopback URL for the TEST bridge provider. Refusing to boot.`);
  return value;
}

/** The TEST provider from the environment, or null when the bridge runs on the owner's (blank) table. Bad values refuse to boot. */
export function bridgeProviderFromEnv(env: Record<string, string | undefined> = process.env): BridgeProvider | null {
  if (env.PROTOCOL_BRIDGE_ROUTES?.trim() !== 'TEST' || !isExplicitDevOrTest(env.APP_ENV)) return null;
  const tokenAddress = env.PROTOCOL_BRIDGE_TOKEN_ADDRESS?.trim() ?? '';
  const rpcUrls = env.PROTOCOL_BRIDGE_RPC_URLS?.trim() ?? '';
  const attesterUrl = env.PROTOCOL_BRIDGE_ATTESTER_URL?.trim() ?? '';
  if (!tokenAddress && !rpcUrls && !attesterUrl) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) throw new Error('PROTOCOL_BRIDGE_TOKEN_ADDRESS must be an address. Refusing to boot.');
  let json: unknown;
  try {
    json = JSON.parse(rpcUrls);
  } catch {
    json = null;
  }
  const parsed = RPC_URLS.safeParse(json);
  if (!parsed.success) throw new Error('PROTOCOL_BRIDGE_RPC_URLS must be JSON {"<chainId>": "<url>"}. Refusing to boot.');
  const chains = new Map<number, BridgeChain>();
  for (const [id, url] of Object.entries(parsed.data)) {
    const client = createPublicClient({ transport: http(loopback('PROTOCOL_BRIDGE_RPC_URLS', url), { timeout: 5_000 }) });
    chains.set(Number(id), chainReader(client));
  }
  const attester = loopback('PROTOCOL_BRIDGE_ATTESTER_URL', attesterUrl);
  const address: Address = getAddress(tokenAddress);
  return {
    // The TEST token's symbol, as the TEST route table names it (routes.ts TEST_BRIDGE_ROUTES), and its 6 decimals.
    tokens: { TUSDC: { address, decimals: 6 } },
    chain: (chainId) => chains.get(chainId) ?? null,
    attestation: (sourceChainId, burnTx) => fetchAttestation(attester, sourceChainId, burnTx),
  };
}
