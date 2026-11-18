/**
 * RC-p2p-02: the contract escrow beside the ledger escrow.
 *
 * Two facts are not this service's and are read, never copied:
 *   · whether the SovereignEscrow contract is deployed on the configured chain, and that chain (svc-protocol
 *     `escrow.status`);
 *   · one deal's state (svc-protocol `escrow.deal`), read from the chain when a party attaches or syncs it.
 * Both are asked under the edge-signed principal of the request itself (`forwardedPrincipalHeaders`), the same way the
 * take gate asks identity. svc-p2p calls svc-protocol only through the published contract and never reads its tables.
 *
 * Two facts are the owner's and stay blank until set, refusing by name:
 *   · `P2P_CONTRACT_ESCROW_TOKENS`: which token on that chain carries each P2P asset (JSON `{ "USDC": { "address":
 *     "0x…", "decimals": 6 } }`);
 *   · `P2P_CONTRACT_ESCROW_DISPUTE_WINDOW_SECONDS`: how long a contract dispute runs before anyone may settle it by the
 *     refund both parties agreed when the deal opened.
 */
import { forwardedPrincipalHeaders, unwrapTrpcData, type Context } from '@intafaced/contracts';
import { protocolEscrowDealOutputSchema, protocolEscrowStatusOutputSchema } from '@intafaced/contracts/protocol-escrow';
import { z } from 'zod';
import { P2pError, type ContractDealRead } from './p2p-service.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const tokensSchema = z.record(z.string().min(1), z.object({ address, decimals: z.number().int().min(0).max(18) }).strict());

export type ContractEscrowTokens = z.infer<typeof tokensSchema>;

/** `P2P_CONTRACT_ESCROW_TOKENS`: blank is null (not offered); anything that is not the published shape refuses boot. */
export function parseContractEscrowTokens(raw: string | undefined): ContractEscrowTokens | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = tokensSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error(`P2P_CONTRACT_ESCROW_TOKENS is not {"ASSET": {"address": "0x…", "decimals": n}}: ${parsed.error.message}`);
  return parsed.data;
}

export type ProtocolEscrowStatus = z.infer<typeof protocolEscrowStatusOutputSchema>;

/** svc-protocol's escrow reads, for the person of the request. Every failure is a typed refusal, never a guess. */
export interface ProtocolEscrowReader {
  status(ctx: Pick<Context, 'forwardedPrincipal'>): Promise<ProtocolEscrowStatus>;
  deal(ctx: Pick<Context, 'forwardedPrincipal'>, dealId: string): Promise<ContractDealRead>;
}

export interface ContractEscrowSetting {
  tokens: ContractEscrowTokens | null;
  disputeWindowSeconds: number | null;
  reader: ProtocolEscrowReader | null;
}

const unavailable = (why: string) => new P2pError(`The contract escrow is not available: ${why}`, 'p2p.contract_escrow_unavailable');

async function getJson(fetcher: typeof fetch, target: string, headers: Record<string, string>, timeoutMs: number) {
  const response = await fetcher(target, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? `svc-protocol answered ${response.status}`;
    return { ok: false as const, message };
  }
  return { ok: true as const, data: unwrapTrpcData(body) };
}

export function createProtocolEscrowReader(options: {
  protocolUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): ProtocolEscrowReader {
  const base = options.protocolUrl.replace(/\/$/, '');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const headersOf = (ctx: Pick<Context, 'forwardedPrincipal'>) => {
    const headers = forwardedPrincipalHeaders(ctx);
    if (Object.keys(headers).length === 0) throw unavailable('no edge-signed principal on this request to read the chain for');
    return headers;
  };
  return {
    async status(ctx) {
      let res;
      try {
        res = await getJson(fetcher, `${base}/trpc/escrow.status`, headersOf(ctx), timeoutMs);
      } catch (err) {
        if (err instanceof P2pError) throw err;
        throw unavailable('svc-protocol could not be reached');
      }
      // On a mainnet chain svc-protocol refuses `audit.external`; its message names the blocker.
      if (!res.ok) throw unavailable(res.message);
      const parsed = protocolEscrowStatusOutputSchema.safeParse(res.data);
      if (!parsed.success) throw unavailable('svc-protocol answered a status that is not the published shape');
      return parsed.data;
    },
    async deal(ctx, dealId) {
      const target = `${base}/trpc/escrow.deal?input=${encodeURIComponent(JSON.stringify({ dealId }))}`;
      let res;
      try {
        res = await getJson(fetcher, target, headersOf(ctx), timeoutMs);
      } catch (err) {
        if (err instanceof P2pError) throw err;
        throw unavailable('svc-protocol could not be reached; read the deal again');
      }
      if (!res.ok) throw new P2pError(`Deal ${dealId} could not be read: ${res.message}`, 'p2p.escrow_deal_mismatch');
      const parsed = protocolEscrowDealOutputSchema.safeParse(res.data);
      if (!parsed.success) throw unavailable('svc-protocol answered a deal that is not the published shape');
      return parsed.data;
    },
  };
}

/** What a person choosing the escrow sees for one asset: offered or not, and why not. */
export interface ContractEscrowOffer {
  available: boolean;
  /** The refusal code when not available (`p2p.contract_escrow_unavailable` carrying the protocol blocker). */
  blocker: string | null;
  reason: string | null;
  network: { chainId: number; label: string; escrow: string } | null;
  token: { address: string; decimals: number } | null;
  disputeWindowSeconds: number | null;
  timeout: 'refund_seller';
  mainnet: { available: false; blocker: 'audit.external' };
  audited: false;
}

/**
 * The contract terms for an order in `asset`, or a refusal naming the blocker: the owner's token or window is blank, the
 * contract is not deployed, the chain is mainnet (`audit.external`), or svc-protocol cannot be read.
 */
export async function contractTermsFor(
  setting: ContractEscrowSetting,
  ctx: Pick<Context, 'forwardedPrincipal'>,
  asset: string,
): Promise<{ chainId: number; token: string; decimals: number; disputeWindowSeconds: number; label: string; escrow: string }> {
  if (!setting.reader) throw unavailable('svc-protocol is not connected (PROTOCOL_URL is unset)');
  if (!setting.tokens) throw unavailable('the owner has not published which token carries each asset (P2P_CONTRACT_ESCROW_TOKENS)');
  const token = setting.tokens[asset];
  if (!token) throw unavailable(`no token on the escrow's chain carries ${asset}`);
  if (setting.disputeWindowSeconds === null)
    throw unavailable('the owner has not published the dispute window (P2P_CONTRACT_ESCROW_DISPUTE_WINDOW_SECONDS)');
  const status = await setting.reader.status(ctx);
  if (!status.testnet.deployed || !status.testnet.escrow)
    throw unavailable(
      `${status.testnet.blocker ?? 'protocol.escrow_not_deployed'}: the escrow contract is not deployed on ${status.testnet.label}`,
    );
  return {
    chainId: status.testnet.chainId,
    token: token.address,
    decimals: token.decimals,
    disputeWindowSeconds: setting.disputeWindowSeconds,
    label: status.testnet.label,
    escrow: status.testnet.escrow,
  };
}

export async function contractEscrowOffer(
  setting: ContractEscrowSetting,
  ctx: Pick<Context, 'forwardedPrincipal'>,
  asset: string,
): Promise<ContractEscrowOffer> {
  const fixed = {
    timeout: 'refund_seller' as const,
    mainnet: { available: false as const, blocker: 'audit.external' as const },
    audited: false as const,
  };
  try {
    const terms = await contractTermsFor(setting, ctx, asset);
    return {
      available: true,
      blocker: null,
      reason: null,
      network: { chainId: terms.chainId, label: terms.label, escrow: terms.escrow },
      token: { address: terms.token, decimals: terms.decimals },
      disputeWindowSeconds: terms.disputeWindowSeconds,
      ...fixed,
    };
  } catch (err) {
    if (!(err instanceof P2pError)) throw err;
    return { available: false, blocker: err.code, reason: err.message, network: null, token: null, disputeWindowSeconds: null, ...fixed };
  }
}
