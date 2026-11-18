import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * ONE WRITTEN RECORD PER CALL. A call between an app and a service, or between two services, is declared once here or in a
 * shared package that sits below contracts: the service that serves it, how it is reached, what goes in and what comes back.
 * The service mounts its route from the record (`.input(record.input).output(record.output)` for tRPC; `record.input.parse`
 * for an HTTP route) and every caller takes its types and its reply parser from the same record. A hand copy of either side
 * then has nothing to drift from: change the record and every caller that disagrees fails to compile.
 *
 * Services export routers nothing may import (the boundary scan forbids an app or package depending on a service), so the
 * record lives here and the router is checked against it, never generated from it.
 *
 * `procedures.schema.json` beside this package holds the language-neutral form of every record (JSON Schema, draft 2020-12),
 * written by `pnpm --filter @intafaced/contracts procedures:write` and held by `procedure-registry.test.ts`.
 */

/** A tRPC procedure on a service's root router: `path` is the dotted procedure path. */
export interface TrpcTransport {
  readonly transport: 'trpc';
  readonly kind: 'query' | 'mutation';
  readonly path: string;
}

/** A plain HTTP route: `path` is the route template, with `:name` segments filled by the caller. */
export interface HttpTransport {
  readonly transport: 'http';
  readonly method: 'GET' | 'POST';
  readonly path: `/${string}`;
}

export type ProcedureRecord<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = (TrpcTransport | HttpTransport) & {
  /** Stable name of the record; the key in `procedures.schema.json`. */
  readonly name: string;
  /** The service that serves the call. */
  readonly service: ServiceName;
  /** The edge's module prefix an app reaches the service under (`/api/<module>/...`), when apps call it at all. */
  readonly module?: string;
  readonly input: I;
  readonly output: O;
};

/** What a caller sends: the schema's input side, so defaults and optional fields stay optional. */
export type ProcedureInput<R extends ProcedureRecord> = z.input<R['input']>;
/** What a caller reads back after parsing with `record.output`. */
export type ProcedureOutput<R extends ProcedureRecord> = z.output<R['output']>;

/** Declares a call. Frozen, so a caller cannot swap the schema it is checked against. */
export function defineProcedure<const R extends ProcedureRecord>(record: R): R {
  return Object.freeze(record);
}

/** Fills an HTTP route template's `:name` segments, each URI-encoded. A missing parameter throws: no route is guessed. */
export function routePath(record: HttpTransport, params: Readonly<Record<string, string>>): string {
  return record.path.replace(/:([A-Za-z]\w*)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`route ${record.path} needs :${name}`);
    return encodeURIComponent(value);
  });
}

/** The language-neutral form of one record: how it is reached, and both sides as JSON Schema. */
export function procedureJsonSchema(record: ProcedureRecord): Record<string, unknown> {
  const reach =
    record.transport === 'trpc'
      ? { transport: 'trpc', kind: record.kind, path: record.path }
      : { transport: 'http', method: record.method, path: record.path };
  return {
    service: record.service,
    ...(record.module === undefined ? {} : { module: record.module }),
    ...reach,
    input: z.toJSONSchema(record.input, { io: 'input', unrepresentable: 'any' }),
    output: z.toJSONSchema(record.output, { io: 'output', unrepresentable: 'any' }),
  };
}

/** The text of a package's `procedures.schema.json`: every record by name, in name order, as `procedureJsonSchema` writes it. */
export function procedureSchemaFile(records: readonly ProcedureRecord[]): string {
  const names = records.map((r) => r.name);
  if (new Set(names).size !== names.length) throw new Error(`two records share a name: ${names.join(', ')}`);
  const byName = Object.fromEntries([...records].sort((a, b) => a.name.localeCompare(b.name)).map((r) => [r.name, procedureJsonSchema(r)]));
  return `${JSON.stringify({ $comment: 'Written by `procedures:write`; held by its drift test. Do not edit by hand.', procedures: byName }, null, 2)}\n`;
}
