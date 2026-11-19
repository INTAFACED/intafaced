import {
  TRPCError,
  type AnyTRPCRouter,
  type TRPCCreateRouterOptions,
  type TRPCMutationProcedure,
  type TRPCQueryProcedure,
} from '@trpc/server';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import type { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import { NO_INPUT, type Access, type ProcedureRecord, type RefusalStatus, type TrpcTransport } from './procedure.js';
import { publicJurisdictionProcedure, publicProcedure, router, scopedProcedure, serviceProcedureFor, type Context } from './trpc.js';

/**
 * Mounts a service's tRPC surface from its records. The record decides the path, query or mutation,
 * the guard, the input and output schemas, and which named refusals may leave. The service supplies only handlers and
 * one function that reads its own refusal type (`refusalOf`), once per service, never per call.
 */

/** What a handler receives: the guarded context and the parsed input. */
export type RecordHandler<R extends ProcedureRecord> = (args: {
  /** A `scope` record's guard has verified the principal, so its handler reads it without a check of its own. */
  ctx: R['access'] extends { readonly caller: 'scope' } ? Context & { principal: Principal } : Context;
  input: z.output<R['input']>;
}) => Promise<z.input<R['output']>> | z.input<R['output']>;

/** Reads a thrown value as one of the service's named refusals, already in its wire form; `undefined` when it is not one. */
export type RefusalOf = (err: unknown) => { readonly code: string; readonly error: TRPCError } | undefined;

/** A refusal the record does not list, or lists with another status. */
export class UndeclaredRefusalError extends Error {
  readonly record: string;
  readonly code: string;
  constructor(sent: {
    readonly record: string;
    readonly code: string;
    readonly status: string;
    readonly declared: RefusalStatus | undefined;
  }) {
    super(
      `${sent.record} refused ${sent.code} as ${sent.status}, but its record ${sent.declared === undefined ? 'does not list it' : `says ${sent.declared}`}`,
    );
    this.name = 'UndeclaredRefusalError';
    this.record = sent.record;
    this.code = sent.code;
  }
}

/**
 * With `PROCEDURE_REFUSALS_SEEN` set to a directory (a service's test run), each refusal sent is noted there as
 * `<record>\t<code>`, so the run can show that every refusal a record lists is produced by some test.
 */
function noteSent(record: string, code: string): void {
  const dir = process.env.PROCEDURE_REFUSALS_SEEN;
  if (dir) appendFileSync(join(dir, `${process.pid}-${threadId}.tsv`), `${record}\t${code}\n`);
}

function guardFor(access: Access) {
  switch (access.caller) {
    case 'public':
      return publicProcedure;
    case 'jurisdiction':
      return publicJurisdictionProcedure(access.module, access.plane);
    case 'scope':
      return scopedProcedure(access.scope, {
        ...(access.module === undefined ? {} : { module: access.module }),
        ...(access.plane === undefined ? {} : { plane: access.plane }),
        ...(access.tier === undefined ? {} : { tier: access.tier }),
        ...(access.person === undefined ? {} : { person: access.person }),
      });
    case 'service':
      return serviceProcedureFor(access.callers);
  }
}

/**
 * One tRPC procedure from one record, typed from the record (its handler's input and reply, and the procedure a caller
 * sees), for a router not made from records yet. `mountRecords` mounts a whole router.
 */
export function mountRecord<const R extends TrpcRecord>(record: R, handler: RecordHandler<R>, refusalOf: RefusalOf): MountedProcedure<R>;
export function mountRecord(
  record: ProcedureRecord,
  handler: RecordHandler<ProcedureRecord>,
  refusalOf: RefusalOf,
): TRPCQueryProcedure<Def<ProcedureRecord>> | TRPCMutationProcedure<Def<ProcedureRecord>>;
export function mountRecord(record: ProcedureRecord, handler: RecordHandler<ProcedureRecord>, refusalOf: RefusalOf) {
  if (record.transport !== 'trpc') throw new Error(`${record.name} is a plain HTTP door; mount it with its HTTP adapter`);
  const guarded = guardFor(record.access);
  const typed = record.input === NO_INPUT ? guarded : guarded.input(record.input);
  const withOutput = typed.output(record.output);
  const resolve = async ({ ctx, input }: { ctx: Context; input: unknown }) => {
    try {
      return await handler({ ctx, input });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal === undefined) throw err;
      const declared = record.refusals[refusal.code];
      noteSent(record.name, refusal.code);
      // Outside tests an unlisted refusal is sent unchanged, so the wire is what the handler says.
      if (declared !== refusal.error.code && process.env.PROCEDURE_REFUSALS_STRICT === '1') {
        throw new UndeclaredRefusalError({ record: record.name, code: refusal.code, status: refusal.error.code, declared });
      }
      throw refusal.error;
    }
  };
  return record.kind === 'query' ? withOutput.query(resolve) : withOutput.mutation(resolve);
}

type HandlerMap<Rs extends readonly ProcedureRecord[]> = { [R in Rs[number] as R['name']]: RecordHandler<R> };

type TrpcRecord = ProcedureRecord & TrpcTransport;
type CallerInput<R extends ProcedureRecord> = R['input'] extends typeof NO_INPUT ? void : z.input<R['input']>;
type Def<R extends ProcedureRecord> = { input: CallerInput<R>; output: z.output<R['output']>; meta: unknown };
/** The tRPC procedure a record mounts as, so `createCaller` and clients are typed from the record. */
type MountedProcedure<R extends ProcedureRecord> = R extends { kind: 'mutation' }
  ? TRPCMutationProcedure<Def<R>>
  : TRPCQueryProcedure<Def<R>>;
/** `a.b.c` as `{ a: { b: { c: V } } }`. */
type Nest<P extends string, V> = P extends `${infer Head}.${infer Tail}` ? { [K in Head]: Nest<Tail, V> } : { [K in P]: V };
type Merge<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
/** The router a list of records mounts as: each record's procedure at its dotted path. */
export type RecordRouterShape<Rs extends readonly ProcedureRecord[]> = Merge<
  { [I in keyof Rs]: Rs[I] extends TrpcRecord ? Nest<Rs[I]['path'], MountedProcedure<Rs[I]>> : never }[number]
>;
type RecordRouter<Rs extends readonly ProcedureRecord[]> = ReturnType<typeof router<RecordRouterShape<Rs> & TRPCCreateRouterOptions>>;

type Mounted = ReturnType<typeof mountRecord>;
interface Tree {
  [key: string]: Tree | Mounted;
}
const isTree = (node: Tree | Mounted): node is Tree => !('_def' in node);

/**
 * A service's whole router from its records: one handler per record name, nothing else. A handler with no record, or a
 * record with no handler, fails at startup. Dotted paths (`basisOverride.set`) become nested routers.
 */
export function mountRecords<const Rs extends readonly ProcedureRecord[]>(
  records: Rs,
  handlers: NoInfer<HandlerMap<Rs>>,
  refusalOf: RefusalOf,
): RecordRouter<Rs>;
export function mountRecords(records: readonly ProcedureRecord[], handlers: object, refusalOf: RefusalOf): AnyTRPCRouter {
  const byName = new Map<string, RecordHandler<ProcedureRecord>>(Object.entries(handlers));
  const names = new Set(records.map((r) => r.name));
  for (const name of byName.keys()) if (!names.has(name)) throw new Error(`handler ${name} has no record`);
  const tree: Tree = {};
  for (const record of records) {
    const handler = byName.get(record.name);
    if (handler === undefined) throw new Error(`record ${record.name} has no handler`);
    if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
    const parts = record.path.split('.');
    const leaf = parts.pop();
    if (leaf === undefined) throw new Error(`${record.name} has an empty path`);
    let node = tree;
    for (const part of parts) {
      const child = node[part] ?? {};
      if (!isTree(child)) throw new Error(`${record.path} mounts under the procedure ${part}`);
      node[part] = child;
      node = child;
    }
    if (node[leaf] !== undefined) throw new Error(`two records mount ${record.path}`);
    node[leaf] = mountRecord(record, handler, refusalOf);
  }
  // tRPC 11 takes nested plain objects as nested routers.
  return router(tree);
}

export { TRPCError };
