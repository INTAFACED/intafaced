/**
 * Typed calls whose input and output types come from `@intafaced/contracts`.
 *
 * A screen names a procedure once, with the schemas the back end itself uses, and the call below infers the input it
 * accepts and the data it returns. Nothing is declared by hand on this side, so a field the service adds cannot be
 * stripped silently and a field it renames fails the typecheck here.
 *
 *   import { rankStateSchema } from '@intafaced/contracts/identity';
 *   const rankGet = contractProcedure('identity', 'rank.get', { output: rankStateSchema });
 *   const result = await readContract(api, rankGet, undefined, { signal });   // result.data is a RankState
 *
 * `output` is parsed on every answer. A shape that does not match is an `invalid_response` refusal, never a guess.
 * `input` is checked by the compiler only; the service stays the authority on what it accepts.
 *
 * A screen that must narrow what it trusts (the answer must be about the signed-in account, say) passes
 * `contractSchema.refine(...)` or `.extend(...)` as `output`; the narrowing is then written once, next to the call.
 */
import type { ZodType, ZodTypeAny, input as ZodInput, output as ZodOutput } from 'zod';
import type { ApiClient, ApiResult, RequestOptions } from './api';

export type ContractProcedure<Out extends ZodTypeAny = ZodTypeAny, In extends ZodTypeAny | undefined = ZodTypeAny | undefined> = {
  readonly module: string;
  readonly procedure: string;
  readonly output: Out;
  readonly input: In;
};

/** Binds one tRPC procedure name to the contract schemas that describe it. Omit `input` for a procedure that takes none. */
export function contractProcedure<Out extends ZodTypeAny>(
  module: string,
  procedure: string,
  schemas: { output: Out },
): ContractProcedure<Out, undefined>;
export function contractProcedure<Out extends ZodTypeAny, In extends ZodTypeAny>(
  module: string,
  procedure: string,
  schemas: { output: Out; input: In },
): ContractProcedure<Out, In>;
export function contractProcedure(
  module: string,
  procedure: string,
  schemas: { output: ZodTypeAny; input?: ZodTypeAny },
): ContractProcedure {
  return { module, procedure, output: schemas.output, input: schemas.input };
}

/** What the call accepts: the contract's input type, or nothing for a procedure that has no input schema. */
export type ContractInput<P extends ContractProcedure> = P['input'] extends ZodTypeAny ? ZodInput<P['input']> : undefined;
/** What a successful call returns: the contract's output type. */
export type ContractData<P extends ContractProcedure> = ZodOutput<P['output']>;

/** A procedure that takes no input, or whose input is optional, may be called without one. */
type CallArgs<P extends ContractProcedure> =
  undefined extends ContractInput<P>
    ? [input?: ContractInput<P>, options?: RequestOptions]
    : [input: ContractInput<P>, options?: RequestOptions];

// `ZodType<Out, unknown>` lets a schema with a refine, a transform or a default stand in as the output.
const asSchema = <P extends ContractProcedure>(procedure: P) => procedure.output as ZodType<ContractData<P>, unknown>;

/** A tRPC query (HTTP GET). */
export function readContract<P extends ContractProcedure>(
  api: Pick<ApiClient, 'query'>,
  procedure: P,
  ...[input, options]: CallArgs<P>
): Promise<ApiResult<ContractData<P>>> {
  return api.query(procedure.module, procedure.procedure, input, asSchema(procedure), options);
}

/** A tRPC mutation (HTTP POST). The caller supplies the business idempotency key as part of `input` where the contract has one. */
export function writeContract<P extends ContractProcedure>(
  api: Pick<ApiClient, 'mutate'>,
  procedure: P,
  ...[input, options]: CallArgs<P>
): Promise<ApiResult<ContractData<P>>> {
  return api.mutate(procedure.module, procedure.procedure, input, asSchema(procedure), options);
}
