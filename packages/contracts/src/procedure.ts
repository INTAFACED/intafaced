import { z } from 'zod';
import type { Scope } from '@intafaced/auth';
import type { KycTier, ModuleId, Plane } from '@intafaced/config';
import type { ServiceName, ServingServiceName } from './service-keys.js';
import { portabilityFindings, REFINEMENT, SchemaNotPortableError, strictJsonSchema } from './procedure-strict-schema.js';

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

/**
 * A plain HTTP route: `path` is the route template, with `:name` segments filled by the caller. The body (POST) or the
 * query (GET) is the bare input; the reply is the bare output, with no tRPC envelope. `params` names the template's
 * segments, one string field each; `defineProcedure` refuses a record whose template and `params` disagree.
 */
export interface HttpTransport {
  readonly transport: 'http';
  readonly method: 'GET' | 'POST';
  readonly path: `/${string}`;
  readonly params?: z.ZodObject<Record<string, z.ZodString>>;
}

/**
 * Who may call. The serving side mounts the matching guard (`procedure-mount.ts`): `public` checks nothing, `scope` is
 * `scopedProcedure(scope, guards)`, `service` is `serviceProcedureFor(callers)` or, on a plain HTTP door, the service's
 * own signed-caller check against the same list. The record names the rule; the receiver reads the live facts.
 */
export type Access =
  | { readonly caller: 'public' }
  | {
      readonly caller: 'scope';
      readonly scope: Scope;
      readonly module?: ModuleId;
      readonly plane?: Plane;
      readonly tier?: KycTier;
      readonly person?: boolean;
    }
  | { readonly caller: 'service'; readonly callers: readonly ServiceName[] };

/** The tRPC codes a refusal is sent with (a plain HTTP door maps them to its status). */
export type RefusalStatus =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'TOO_MANY_REQUESTS'
  | 'SERVICE_UNAVAILABLE';

/** Every named refusal the call may answer with, by its machine code, and the status it is sent with. */
export type Refusals = Readonly<Record<string, RefusalStatus>>;

/**
 * A check the receiver runs on the input beyond what JSON Schema can say (a zod `.refine` or `.superRefine`), named so every
 * implementation of the record must carry it. `at` is where it sits (`input`, `input.day`), or every place one shared rule
 * sits; `says` is the rule in words.
 * The export refuses an unnamed refinement and a named one that is no longer there.
 */
export interface InputCheck {
  readonly at: string | readonly string[];
  readonly says: string;
}

/** A caller's check over a reply the schema already parsed; `says` is the rule in words, for other languages. */
export interface ReplyCheck {
  readonly says: string;
  readonly holds: (reply: unknown) => boolean;
}

/** True when the reply passes every one of the record's `accept` checks. */
export function replyAccepted(record: Pick<ProcedureRecord, 'accept'>, reply: unknown): boolean {
  return Object.values(record.accept ?? {}).every((check) => check.holds(reply));
}

/**
 * One input and the verdict every side that implements the record must reach on it: the record's own schema, its
 * language-neutral export, and the mounted route. `by` names the input check (`checks`) that alone refuses it, so the
 * export (which carries that check only by name) accepts it. `input` absent means the call is sent with no input.
 */
export interface ProcedureSample {
  readonly verdict: 'accept' | 'refuse';
  readonly input?: unknown;
  readonly by?: string;
}

export type ProcedureRecord<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = (TrpcTransport | HttpTransport) & {
  /** Stable name of the record; the key in `procedures.schema.json`. */
  readonly name: string;
  /** The service that serves the call. */
  readonly service: ServingServiceName;
  /** The edge's module prefix an app reaches the service under (`/api/<module>/...`), when apps call it at all. */
  readonly module?: string;
  readonly input: I;
  readonly output: O;
  /** Who may call; the receiver enforces it. Required: a record that names nobody does not compile. */
  readonly access: Access;
  /** The named refusals the handler may send. A refusal not listed here fails the strict mount (tests, `procedure-mount.ts`). */
  readonly refusals: Refusals;
  /** The input checks JSON Schema cannot carry, by name. */
  readonly checks?: Readonly<Record<string, InputCheck>>;
  /**
   * The callers' own checks over the reply, beyond its schema, by name: a caller holding the answer to a stricter rule
   * writes it here, where every caller (`api.call`, `callHttpRecord`) runs it, rather than in one caller's copy. A reply one
   * of them refuses reads as unverified, never as data.
   */
  readonly accept?: Readonly<Record<string, ReplyCheck>>;
  /** Inputs every implementation must accept or refuse alike: at least one accepted, one refused, one per input check. */
  readonly samples: readonly ProcedureSample[];
};

/** The input of a call that takes none (tRPC: no `.input()`; HTTP: no body). Exported as `input: null`. */
export const NO_INPUT = z.undefined();

/** What a caller sends: the schema's input side, so defaults and optional fields stay optional. */
export type ProcedureInput<R extends ProcedureRecord> = z.input<R['input']>;
/** What a caller reads back after parsing with `record.output`. */
export type ProcedureOutput<R extends ProcedureRecord> = z.output<R['output']>;

/** Declares a call. Frozen, so a caller cannot swap the schema it is checked against. */
export function defineProcedure<const R extends ProcedureRecord>(record: R): R {
  if (record.transport === 'http') {
    const inTemplate = [...record.path.matchAll(/:(?<name>[A-Za-z]\w*)/g)].map((m) => m.groups?.name ?? '').sort();
    const declared = Object.keys(record.params?.shape ?? {}).sort();
    if (inTemplate.join(',') !== declared.join(',')) {
      throw new Error(`${record.name}: route ${record.path} has parameters [${inTemplate}] but the record declares [${declared}]`);
    }
  }
  const verdicts = new Set(record.samples.map((s) => s.verdict));
  if (!verdicts.has('accept') || (record.input !== NO_INPUT && !verdicts.has('refuse'))) {
    throw new Error(`${record.name}: samples need at least one accepted input${record.input === NO_INPUT ? '' : ' and one refused input'}`);
  }
  for (const name of Object.keys(record.checks ?? {})) {
    if (!record.samples.some((s) => s.verdict === 'refuse' && s.by === name))
      throw new Error(`${record.name}: no sample is refused by input check ${name}`);
  }
  for (const s of record.samples) {
    if (s.by !== undefined && (s.verdict !== 'refuse' || record.checks?.[s.by] === undefined)) {
      throw new Error(`${record.name}: a sample names ${s.by}, which is not a refusing input check of this record`);
    }
  }
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
    ...(record.transport === 'http' && record.params ? { params: strictJsonSchema(`${record.name}.params`, record.params, 'input') } : {}),
    access: record.access,
    refusals: record.refusals,
    ...inputJsonSchema(record),
    output: strictJsonSchema(`${record.name}.output`, record.output, 'output'),
    ...(record.checks === undefined ? {} : { checks: record.checks }),
    ...(record.accept === undefined
      ? {}
      : { accept: Object.fromEntries(Object.entries(record.accept).map(([name, check]) => [name, check.says])) }),
    samples: record.samples.map((sample) => ({
      verdict: sample.verdict,
      ...(sample.by === undefined ? {} : { by: sample.by }),
      ...('input' in sample && sample.input !== undefined ? { input: sample.input } : {}),
    })),
  };
}

/**
 * The input side of the export. No input is `input: null`. An input that may be absent as a whole is
 * `inputOptional: true` beside the schema of what it is when present, since JSON Schema has no absent document. A
 * refinement must be named in `checks` at the place it sits; the rest must export exactly.
 */
function inputJsonSchema(record: ProcedureRecord): Record<string, unknown> {
  if (record.input === NO_INPUT) return { input: null };
  const optional = record.input instanceof z.ZodOptional;
  const present = record.input instanceof z.ZodOptional ? record.input.unwrap() : record.input;
  const named = new Map(
    Object.entries(record.checks ?? {}).flatMap(([name, check]) =>
      (typeof check.at === 'string' ? [check.at] : check.at).map((at) => [at, name] as const),
    ),
  );
  const findings = portabilityFindings(present, 'input', 'input');
  const used = new Set<string>();
  const left = findings.filter((f) => {
    if (f.construct !== REFINEMENT || !named.has(f.at)) return true;
    used.add(f.at);
    return false;
  });
  const stale = [...named]
    .filter(([at]) => !used.has(at))
    .map(([at, name]) => ({ at, construct: `input check ${name} names no refinement here` }));
  if (left.length > 0 || stale.length > 0) throw new SchemaNotPortableError(`${record.name}.input`, [...left, ...stale]);
  const schema: Record<string, unknown> = z.toJSONSchema(present, { io: 'input', unrepresentable: 'throw' });
  return optional ? { inputOptional: true, input: schema } : { input: schema };
}

/** The text of a package's `procedures.schema.json`: every record by name, in name order, as `procedureJsonSchema` writes it. */
export function procedureSchemaFile(records: readonly ProcedureRecord[]): string {
  const names = records.map((r) => r.name);
  if (new Set(names).size !== names.length) throw new Error(`two records share a name: ${names.join(', ')}`);
  const byName = Object.fromEntries([...records].sort((a, b) => a.name.localeCompare(b.name)).map((r) => [r.name, procedureJsonSchema(r)]));
  return `${JSON.stringify({ $comment: 'Written by `procedures:write`; held by its drift test. Do not edit by hand.', procedures: byName }, null, 2)}\n`;
}
