import { encodeFunctionData, parseAbi } from 'viem';
import type { ProtocolPathOutput, ProtocolSwapV2Settings } from '@intafaced/contracts/protocol-swap-v2';
import type { ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
import type { SequenceStep } from '../wallet/WalletProvider';
import type { SwapV2Api } from './api-v2';
import { BPS, formatUnits } from './swap-math';

/**
 * The router v2 swap's steps (D-swap-03, D-swap-intents-01, -02), built from what the service read: the approval the
 * person chose (an approve transaction, one signature for this swap, or a standing allowance until a date), then the one
 * swap call. Pure planning: nothing here signs or sends; the wallet's sheet shows every step before anything happens.
 */
export type AllowanceChoice = 'onchain' | 'permit' | 'standing';
export type SwapKind = 'exact_in' | 'exact_out';
/** The standing-allowance lifetimes offered, in seconds; the owner's lifetime cap leaves out any longer one. */
export const STANDING_CHOICES = [60, 3_600, 86_400, 7 * 86_400, 30 * 86_400] as const;
/** The native currency in the token pickers: its address is the wrapped token router v2 wraps it into. */
export const NATIVE_VALUE = 'native';

/** Exact in: each hop's least output at `bps` slippage. Exact out: the most paid, rounded up. */
export function limitsFor(path: ProtocolPathOutput, bps: number): { minOutPerHop: bigint[]; maxIn: bigint | null } {
  if (path.kind === 'exact_in')
    return { minOutPerHop: path.hops.map((hop) => (BigInt(hop.amountOut) * (BPS - BigInt(bps))) / BPS), maxIn: null };
  return { minOutPerHop: [], maxIn: (BigInt(path.amountIn) * (BPS + BigInt(bps)) + BPS - 1n) / BPS };
}

/** "2026-11-07 15:04" in the person's own time zone, from chain seconds. */
export function dateTime(seconds: bigint | number): string {
  const at = new Date(Number(seconds) * 1000);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** Reads "YYYY-MM-DDTHH:MM" (or with a space) in the person's own time zone; null when it is not one. */
export function parseDeadline(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi);
  return Number.isNaN(at.getTime()) ? null : Math.floor(at.getTime() / 1000);
}

export interface V2PlanInput {
  api: SwapV2Api;
  settings: ProtocolSwapV2Settings;
  owner: string;
  kind: SwapKind;
  path: string[];
  pools: string[];
  /** Exact in: the amount paid. Exact out: the amount received. */
  amount: bigint;
  /** What the approval must cover: exact in, the amount; exact out, the most paid. */
  need: bigint;
  tokenIn: ProtocolSwapToken | null; // null: native input
  tokenOut: ProtocolSwapToken;
  native: boolean;
  slippageBps: number;
  /** The limits the person saw: exact in, each hop's minimum; exact out, the most paid. Sent as they are; the service checks them. */
  minOutPerHop: bigint[];
  maxIn: bigint | null;
  /** The person's hop limit (null: blank). */
  maxHops: number | null;
  deadline: bigint;
  allowance: AllowanceChoice;
  standingSeconds: number;
  /** Sign a new standing allowance even when one is in place (the person asked for it after a refusal). */
  renewStanding: boolean;
  fee: { maxFeePerGas: string; maxPriorityFeePerGas: string } | Record<string, never>;
  labels: {
    approve: (amount: string, token: string) => string;
    permit: (amount: string, token: string) => string;
    permitContract: (amount: string, token: string) => string;
    standing: (amount: string, token: string, until: string) => string;
    swap: string;
  };
}

export type V2Plan =
  | {
      ok: true;
      steps: SequenceStep[];
      facts: Array<{ label: string; value: string }>;
      /** Set when the swap pulls through a standing allowance already in place: no signature, so it was checked first. */
      usesStanding: boolean;
    }
  | { ok: false; code: string | undefined; message: string; expiredAt?: bigint };

const hex = (value: string) => `0x${BigInt(value).toString(16)}`;
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

/**
 * The steps for one v2 swap. Approvals come first (approve transactions, then signatures), then the swap, which is built
 * once the signatures exist and carries them as signed. A swap that pulls through a standing allowance already in place
 * is built and checked against the chain before any sheet opens, so an expired one is refused by name, not sent.
 */
export async function planV2Swap(input: V2PlanInput): Promise<V2Plan> {
  const { api, owner, tokenIn } = input;
  const steps: SequenceStep[] = [];
  const facts: Array<{ label: string; value: string }> = [];
  const shown = (units: bigint, token: ProtocolSwapToken) => `${formatUnits(units, token.decimals, token.decimals)} ${token.name}`;
  let tokenPermit: { value: string; deadline: string } | null = null;
  let standing: { amount: string; expiration: string; nonce: number; sigDeadline: string } | null = null;
  let pull: 'allowance' | 'standing' | 'native' = input.native ? 'native' : 'allowance';
  let usesStanding = false;
  let approveSteps = 0;
  const limitsInput = {
    maxHops: input.maxHops,
    ...(input.kind === 'exact_in' ? { minOutPerHop: input.minOutPerHop.map(String) } : {}),
    ...(input.maxIn !== null ? { maxIn: input.maxIn.toString() } : {}),
  };

  if (!input.native && tokenIn) {
    if (input.allowance === 'onchain') {
      const route = await api.approvalRoute({ owner, token: tokenIn.address });
      if (!route.ok) return { ok: false, code: route.code, message: route.message };
      if (BigInt(route.data.routerAllowance) < input.need) {
        const amountText = formatUnits(input.need, tokenIn.decimals, tokenIn.decimals);
        steps.push({
          label: input.labels.approve(amountText, tokenIn.name),
          request: {
            kind: 'transaction',
            to: tokenIn.address,
            // approve(router v2, exactly what this swap needs): never unlimited.
            data: encodeFunctionData({
              abi: APPROVE_ABI,
              functionName: 'approve',
              args: [input.settings.router as `0x${string}`, input.need],
            }),
            ...input.fee,
          },
        });
        approveSteps += 1;
      }
    } else if (input.allowance === 'permit') {
      const permit = await api.buildPermit({
        owner,
        token: tokenIn.address,
        amount: input.need.toString(),
        mode: 'exact',
        expiresAt: input.deadline.toString(),
      });
      if (!permit.ok) return { ok: false, code: permit.code, message: permit.message };
      steps.push({
        label: input.labels.permit(formatUnits(input.need, tokenIn.decimals, tokenIn.decimals), tokenIn.name),
        sign: permit.data.tokenPermit!,
      });
      tokenPermit = { value: input.need.toString(), deadline: input.deadline.toString() };
      facts.push({ label: 'Amount', value: shown(input.need, tokenIn) }, { label: 'Expires', value: dateTime(input.deadline) });
    } else {
      pull = 'standing';
      const route = await api.approvalRoute({ owner, token: tokenIn.address });
      if (!route.ok) return { ok: false, code: route.code, message: route.message };
      const existing = route.data.standing;
      const chainNow = BigInt(route.data.blockTime);
      if (!input.renewStanding && existing) {
        // An allowance is in place: the swap pulls through it until the person asks for a new one. Checked against the
        // chain now, so a pull SovereignPermit would refuse (expired, or too little left) is refused here by name and
        // nothing is signed or sent.
        usesStanding = true;
        const check = await api.buildSwap({
          owner,
          kind: input.kind,
          path: input.path,
          pools: input.pools,
          amount: input.amount.toString(),
          slippageBps: input.slippageBps,
          deadline: input.deadline.toString(),
          pull,
          ...limitsInput,
          simulate: true,
        });
        if (!check.ok) return { ok: false, code: check.code, message: check.message, expiredAt: BigInt(existing.expiration) };
        facts.push(
          { label: 'Amount', value: shown(BigInt(existing.amount), tokenIn) },
          { label: 'Expires', value: dateTime(BigInt(existing.expiration)) },
        );
      } else {
        const expiresAt = chainNow + BigInt(input.standingSeconds);
        const permit = await api.buildPermit({
          owner,
          token: tokenIn.address,
          amount: input.need.toString(),
          mode: 'standing',
          expiresAt: expiresAt.toString(),
        });
        if (!permit.ok) return { ok: false, code: permit.code, message: permit.message };
        const amountText = formatUnits(input.need, tokenIn.decimals, tokenIn.decimals);
        for (const call of permit.data.approveCalls) {
          steps.push({
            label: input.labels.permitContract(amountText, tokenIn.name),
            request: { kind: 'transaction', to: call.to, data: call.data, ...input.fee },
          });
          approveSteps += 1;
        }
        if (permit.data.tokenPermit) {
          steps.push({ label: input.labels.permitContract(amountText, tokenIn.name), sign: permit.data.tokenPermit });
          tokenPermit = { value: input.need.toString(), deadline: expiresAt.toString() };
        }
        steps.push({ label: input.labels.standing(amountText, tokenIn.name, dateTime(expiresAt)), sign: permit.data.standing! });
        const message = permit.data.standing!.message;
        standing = {
          amount: String(message.amount),
          expiration: String(message.expiration),
          nonce: Number(message.nonce),
          sigDeadline: String(message.sigDeadline),
        };
        facts.push({ label: 'Amount', value: shown(input.need, tokenIn) }, { label: 'Expires', value: dateTime(expiresAt) });
      }
    }
  }

  const signs = steps.filter((step) => 'sign' in step).length;
  steps.push({
    label: input.labels.swap,
    preview: JSON.stringify(
      {
        to: input.settings.router,
        kind: input.kind,
        path: input.path,
        pools: input.pools,
        amount: input.amount.toString(),
        ...(input.kind === 'exact_in' ? { minOutPerHop: input.minOutPerHop.map(String) } : { maxIn: input.maxIn?.toString() }),
        value: input.native ? (input.kind === 'exact_in' ? input.amount : (input.maxIn ?? 0n)).toString() : '0',
        deadline: input.deadline.toString(),
        pull,
        signatures: 'inserted exactly as you sign them in the steps above',
      },
      null,
      2,
    ),
    prepare: async (signatures) => {
      const built = await api.buildSwap({
        owner,
        kind: input.kind,
        path: input.path,
        pools: input.pools,
        amount: input.amount.toString(),
        slippageBps: input.slippageBps,
        deadline: input.deadline.toString(),
        pull,
        ...limitsInput,
        ...(tokenPermit ? { tokenPermit: { ...tokenPermit, signature: signatures[0]! } } : {}),
        ...(standing ? { standing: { ...standing, signature: signatures[signs - 1]! } } : {}),
        // Checked against the chain first unless an approve transaction mined just now is what makes it valid.
        simulate: approveSteps === 0,
      });
      if (!built.ok) return { ok: false, message: built.message };
      return {
        ok: true,
        request: {
          kind: 'transaction',
          to: built.data.call.to,
          data: built.data.call.data,
          ...(built.data.call.value !== '0' ? { value: hex(built.data.call.value) } : {}),
          ...input.fee,
        },
      };
    },
  });
  return { ok: true, steps, facts, usesStanding };
}
