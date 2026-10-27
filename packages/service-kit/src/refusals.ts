/**
 * A service's typed refusals, declared once.
 *
 * Every service writes the same four things for each area: a union of codes, a code-to-tRPC-status map, an `Error`
 * class that carries the code, and a function that turns that error into a `TRPCError` whose `cause` keeps the code on
 * the wire (`error.data.cause.code`, which the customer app and the desk read). `defineRefusals` builds all four from
 * the map alone, so a slice states which refusals it has and what status each one is, and nothing else.
 *
 *     export const gradeReports = defineRefusals('GradeReportError', {
 *       'academy.course_not_found': 'NOT_FOUND',
 *       'academy.grade_report_cap_unset': 'PRECONDITION_FAILED',
 *     });
 *     gradeReports.refuse('academy.course_not_found', 'no course has that id');
 *
 * A refusal is never a guess: a code the map does not name does not type-check, and an error that is not this
 * family's passes through `toTrpc` unchanged so the procedure layer keeps its own handling of auth and input errors.
 */
import { TRPCError } from '@intafaced/contracts';

/** The tRPC status a refusal travels as. */
export type RefusalStatus = TRPCError['code'];

/** Strings that explain a refusal to a client (`limit`, `setting`); never money as a number. */
export type RefusalDetails = Readonly<Record<string, string>>;

/** The error every family's refusals extend, so a test or a router can tell a typed refusal from a crash. */
export class RefusalError<C extends string = string> extends Error {
  constructor(
    readonly code: C,
    message: string,
    readonly details?: RefusalDetails,
  ) {
    super(message);
  }
}

export interface RefusalOptions<C extends string> {
  /**
   * The words a person reads for a code (the service's `userCopy`). Without it, or when it returns nothing, the
   * message is `<code>: <message>`, as most services send today.
   */
  readonly copy?: (code: C) => string | undefined;
}

export interface Refusals<C extends string> {
  /** Every code, in the order the map declares them, for catalogue tests and the desk's code list. */
  readonly codes: readonly C[];
  /** The family's error class, for `instanceof` and for code that must construct one without throwing. */
  readonly Error: new (code: C, message?: string, details?: RefusalDetails) => RefusalError<C>;
  /** Throws the refusal. The message defaults to the code. */
  refuse(code: C, message?: string, details?: RefusalDetails): never;
  /** True for this family's refusals only. */
  is(err: unknown): err is RefusalError<C>;
  /** The tRPC status a code travels as. */
  statusOf(code: C): RefusalStatus;
  /** This family's refusal as a `TRPCError` with the refusal as its cause; anything else unchanged. */
  toTrpc(err: unknown): unknown;
  /** Runs a procedure body and throws its refusals as `TRPCError`s: the `try { } catch (err) { throw map(err) }` of every router. */
  guard<T>(body: () => T | Promise<T>): Promise<T>;
}

export function defineRefusals<const M extends Record<string, RefusalStatus>>(
  name: string,
  statuses: M,
  options: RefusalOptions<keyof M & string> = {},
): Refusals<keyof M & string> {
  type C = keyof M & string;
  const codes = Object.keys(statuses) as C[];
  if (codes.length === 0) throw new Error(`defineRefusals(${name}): a family needs at least one code`);

  class FamilyError extends RefusalError<C> {
    constructor(code: C, message: string = code, details?: RefusalDetails) {
      if (!Object.hasOwn(statuses, code)) throw new Error(`${name}: "${code}" is not one of this family's codes`);
      super(code, message, details);
      this.name = name;
    }
  }

  const is = (err: unknown): err is RefusalError<C> => err instanceof FamilyError;

  const toTrpc = (err: unknown): unknown => {
    if (!is(err)) return err;
    const words = options.copy?.(err.code);
    return new TRPCError({ code: statuses[err.code]!, message: words ?? `${err.code}: ${err.message}`, cause: err });
  };

  return {
    codes,
    Error: FamilyError,
    refuse(code, message, details) {
      throw new FamilyError(code, message, details);
    },
    is,
    statusOf: (code) => statuses[code]!,
    toTrpc,
    async guard(body) {
      try {
        return await body();
      } catch (err) {
        throw toTrpc(err);
      }
    },
  };
}
