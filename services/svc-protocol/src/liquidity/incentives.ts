import { encodeFunctionData, getAddress, type Abi, type Address, type PublicClient } from 'viem';
import {
  LIQUIDITY_INCENTIVES_UNSET,
  liquidityIncentiveCallInputSchema,
  liquidityIncentiveCallOutputSchema,
  liquidityIncentivesInputSchema,
  liquidityIncentivesOutputSchema,
  publicJurisdictionProcedure,
  TRPCError,
  type LiquidityIncentiveRow,
} from '@intafaced/contracts';
import { classifyChainError, isZeroAddress } from '../chain/availability.js';
import { loadArtifact } from '../chain/artifacts.js';
import { refuse } from './procedures.js';

/**
 * On-chain liquidity incentives (D-liquidity-09, J-dex-protocol-13 #8), Protocol Plane only. An incentivizer announces,
 * funds from its own wallet and starts each incentive; a provider stakes its pool shares in it and claims what it earned.
 * This service reads the incentives contract and builds the unsigned calls; the wallet signs. The platform funds nothing
 * and holds nothing. A blank contract address refuses `protocol.liquidity_incentives_unset`.
 */
export interface IncentiveDeps {
  client: () => PublicClient;
  rpcUrl: () => string;
  /** `PROTOCOL_LIQUIDITY_INCENTIVES_ADDRESS`. Zero or null refuses. */
  incentives: () => Address | null;
  toTrpcError: (err: unknown) => TRPCError;
}

const abi = () => loadArtifact('LiquidityIncentives').abi as Abi;
const ERC20_META = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const satisfies Abi;

type Raw = {
  pool: Address;
  rewardToken: Address;
  incentivizer: Address;
  refundee: Address;
  total: bigint;
  blocks: bigint;
  funded: boolean;
  startBlock: bigint;
  endBlock: bigint;
  staked: bigint;
};

export function createIncentiveProcedures(deps: IncentiveDeps) {
  const contract = (): Address => {
    const c = deps.incentives();
    if (!c || isZeroAddress(c))
      throw refuse(
        'PRECONDITION_FAILED',
        LIQUIDITY_INCENTIVES_UNSET,
        'the liquidity incentives contract is not configured (PROTOCOL_LIQUIDITY_INCENTIVES_ADDRESS), so no incentive is listed.',
      );
    return getAddress(c);
  };
  const fail = (err: unknown, what: string): TRPCError =>
    err instanceof TRPCError ? err : deps.toTrpcError(classifyChainError(err, what, deps.rpcUrl()));
  const read = <T>(address: Address, a: Abi, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
    deps.client().readContract({ address, abi: a, functionName, args, blockNumber }) as Promise<T>;

  const state = (raw: Raw, block: bigint): LiquidityIncentiveRow['state'] =>
    !raw.funded ? 'unfunded' : raw.startBlock === 0n ? 'ready' : block >= raw.endBlock ? 'ended' : 'running';

  return {
    /** Every incentive announced for `pool`, with the asking account's stake, earnings and split, at one block. */
    incentives: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityIncentivesInputSchema)
      .output(liquidityIncentivesOutputSchema)
      .query(async ({ input }) => {
        try {
          const c = contract();
          const pool = getAddress(input.pool);
          const account = input.account ? getAddress(input.account) : null;
          const block = await deps.client().getBlockNumber();
          const count = await read<bigint>(c, abi(), 'count', [], block);
          const all = await Promise.all(
            Array.from({ length: Number(count) }, (_, id) => read<Raw>(c, abi(), 'get', [BigInt(id)], block).then((raw) => ({ id, raw }))),
          );
          const mine = all.filter(({ raw }) => getAddress(raw.pool) === pool);
          const tokens = new Map<string, { name: string; symbol: string; decimals: number }>();
          for (const { raw } of mine) {
            const t = getAddress(raw.rewardToken);
            if (tokens.has(t)) continue;
            const [name, symbol, decimals] = await Promise.all([
              read<string>(t, ERC20_META, 'name', [], block),
              read<string>(t, ERC20_META, 'symbol', [], block),
              read<number>(t, ERC20_META, 'decimals', [], block),
            ]);
            tokens.set(t, { name, symbol, decimals: Number(decimals) });
          }
          const rows = await Promise.all(
            mine.map(async ({ id, raw }) => {
              const [yourStake, yourReward] = account
                ? await Promise.all([
                    read<bigint>(c, abi(), 'stakeOf', [BigInt(id), account], block),
                    read<bigint>(c, abi(), 'pending', [BigInt(id), account], block),
                  ])
                : [0n, 0n];
              const t = getAddress(raw.rewardToken);
              return {
                id,
                pool,
                rewardToken: { address: t, ...tokens.get(t)! },
                incentivizer: getAddress(raw.incentivizer),
                total: raw.total.toString(),
                blocks: Number(raw.blocks),
                funded: raw.funded,
                state: state(raw, block),
                startBlock: raw.startBlock === 0n ? null : Number(raw.startBlock),
                endBlock: raw.endBlock === 0n ? null : Number(raw.endBlock),
                staked: raw.staked.toString(),
                yourStake: yourStake.toString(),
                yourReward: yourReward.toString(),
                yourSplitBps: raw.staked === 0n ? 0 : Number((yourStake * 10_000n) / raw.staked),
              };
            }),
          );
          return { contract: c, blockNumber: block.toString(), incentives: rows };
        } catch (err) {
          throw fail(err, 'amm.incentives');
        }
      }),

    /**
     * One call to the incentives contract: stake every pool share the account holds (approved to the contract first),
     * unstake all of them, claim what it earned, or start one it funded. An unfunded incentive refuses to start here as
     * the contract would.
     */
    buildIncentiveCall: publicJurisdictionProcedure('protocol', 'protocol')
      .input(liquidityIncentiveCallInputSchema)
      .output(liquidityIncentiveCallOutputSchema)
      .query(async ({ input }) => {
        try {
          const c = contract();
          const account = getAddress(input.account);
          const block = await deps.client().getBlockNumber();
          const count = await read<bigint>(c, abi(), 'count', [], block);
          if (BigInt(input.id) >= count) throw refuse('NOT_FOUND', 'amm.incentive_unknown', `there is no incentive ${input.id}.`);
          const raw = await read<Raw>(c, abi(), 'get', [BigInt(input.id)], block);
          const pool = getAddress(raw.pool);
          let shares = 0n;
          if (input.action === 'stake') {
            shares = await read<bigint>(pool, ERC20_META, 'balanceOf', [account], block);
            if (shares === 0n) throw refuse('BAD_REQUEST', 'amm.no_shares', 'this wallet holds no shares of this pool to stake.');
          }
          if (input.action === 'start' && !raw.funded)
            throw refuse('PRECONDITION_FAILED', 'amm.incentive_unfunded', 'this incentive is not funded, so it cannot start.');
          const args = input.action === 'stake' ? [BigInt(input.id), shares] : [BigInt(input.id)];
          const data = encodeFunctionData({ abi: abi(), functionName: input.action, args });
          return {
            call: { to: c, data, value: '0', summary: `${input.action} on incentive ${input.id}` },
            contract: c,
            shares: shares.toString(),
            pool,
          };
        } catch (err) {
          throw fail(err, 'amm.buildIncentiveCall');
        }
      }),
  };
}
