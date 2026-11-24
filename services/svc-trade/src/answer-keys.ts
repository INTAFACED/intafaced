import type { z } from 'zod';

/** A type's keys all the way down, every leaf erased, so two shapes compare by their keys alone. */
type KeyTree<T> = T extends readonly (infer E)[]
  ? KeyTree<E>[]
  : T extends Date
    ? 'date'
    : T extends object
      ? { -readonly [K in keyof T]-?: KeyTree<T[K]> }
      : 'leaf';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * A router's `.output()` schema checked against the type its handler answers with, at compile time. tRPC already
 * refuses a handler whose answer the schema does not accept; this refuses the other way round: a schema that names
 * fewer keys than the handler answers would strip them from the wire. Call it beside the schema, never in the chain
 * (the call-records codemod copies the schema itself into the record):
 *
 *   const gridSetupAnswer = z.object({ ... });
 *   answerKeys<GridSetupView>()(gridSetupAnswer);
 */
export function answerKeys<Answer>() {
  return <S extends z.ZodType>(
    schema: S &
      (Same<KeyTree<z.input<S>>, KeyTree<Answer>> extends true
        ? unknown
        : { readonly 'the schema and the answer type name different keys': [KeyTree<z.input<S>>, KeyTree<Answer>] }),
  ): S => schema;
}
