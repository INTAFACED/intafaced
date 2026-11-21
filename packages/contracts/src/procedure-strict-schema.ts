import { z } from 'zod';

/**
 * The language-neutral form of a record's schema, refusing what JSON Schema cannot say.
 *
 * `z.toJSONSchema` throws on a transform but silently ERASES other meaning (checked on zod 4.6.7): a `.refine` or
 * `.superRefine` disappears, an optional root input becomes a required object, and `z.unknown()` becomes `{}` (accept
 * anything). A Rust service built from that export would accept what the TypeScript service refuses. So every construct
 * is checked first, and one that the export would erase or cannot express is a named refusal, never a looser schema.
 * A refinement the record names in `checks` is carried by name instead (`procedure.ts`).
 */

export interface PortabilityFinding {
  /** Where in the schema, as a dotted path from the record's input or output. */
  readonly at: string;
  /** What the export cannot carry. */
  readonly construct: string;
}

/** The construct name a refinement finding carries; `procedure.ts` matches it against the record's input `checks`. */
export const REFINEMENT = '.refine/.superRefine (a TypeScript predicate the export drops)';

export class SchemaNotPortableError extends Error {
  constructor(
    readonly label: string,
    readonly findings: readonly PortabilityFinding[],
  ) {
    super(`${label} cannot be exported without losing meaning: ${findings.map((f) => `${f.at} (${f.construct})`).join('; ')}`);
    this.name = 'SchemaNotPortableError';
  }
}

const REFUSED_TYPES: Readonly<Partial<Record<z.core.$ZodTypes['_zod']['def']['type'], string>>> = {
  transform: 'transform (a value computed in TypeScript)',
  custom: 'z.custom (a TypeScript predicate)',
  date: 'Date object (not JSON)',
  bigint: 'bigint (not JSON)',
  map: 'Map (not JSON)',
  set: 'Set (not JSON)',
  promise: 'promise',
  function: 'function',
  symbol: 'symbol',
  undefined: 'undefined',
  void: 'void',
  nan: 'NaN',
  file: 'file',
  catch: '.catch (a fallback value on failure)',
  prefault: '.prefault (a value filled before parsing)',
  success: 'z.success',
  any: 'z.any (no shape: accepts anything)',
  unknown: 'z.unknown (no shape: accepts anything)',
  lazy: 'z.lazy (recursive schema; not supported by the generators yet)',
  intersection: 'intersection (merge semantics differ by generator)',
};

/**
 * Any JSON value, declared on purpose: a stored document whose shape the service does not fix (a proposal's body). zod's
 * own `z.json()`, which the export writes whole (a recursive `anyOf` of the six JSON kinds), so nothing is erased. The one
 * recursive schema the walk lets through, and only this instance of it: `z.unknown()` and any other `z.lazy` stay refused.
 */
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

/** Regex features the JSON Schema dialect (ECMA-262) has and Rust's `regex` crate does not. */
const NON_PORTABLE_REGEX = /\(\?<?[=!]|\\[1-9]|\\k</;

/** Every zod schema is one of zod's own `$ZodTypes`; this lets the walk switch on the definition's `type`. */
function known(schema: z.core.$ZodType): schema is z.core.$ZodTypes {
  return typeof schema._zod.def.type === 'string';
}

interface Walk {
  readonly at: string;
  readonly io: 'input' | 'output';
  readonly root: boolean;
  readonly out: PortabilityFinding[];
}

function walk(schema: z.core.$ZodType, w: Walk): void {
  const next = (child: z.core.$ZodType, at: string, root = false) => walk(child, { ...w, at, root });
  for (const check of schema._zod.def.checks ?? []) {
    const c = check._zod.def;
    if (c.check === 'custom') w.out.push({ at: w.at, construct: REFINEMENT });
    if ('pattern' in c && c.pattern instanceof RegExp && NON_PORTABLE_REGEX.test(c.pattern.source)) {
      w.out.push({ at: w.at, construct: `regex /${c.pattern.source}/ uses lookaround or backreferences (not in Rust regex)` });
    }
  }
  if (!known(schema)) {
    w.out.push({ at: w.at, construct: 'a schema zod does not name' });
    return;
  }
  if (schema === jsonValueSchema) return;
  const def = schema._zod.def;
  const refused = REFUSED_TYPES[def.type];
  if (refused !== undefined) {
    w.out.push({ at: w.at, construct: refused });
    return;
  }
  switch (def.type) {
    case 'object': {
      for (const [key, value] of Object.entries(def.shape)) next(value, `${w.at}.${key}`);
      const catchall = def.catchall;
      if (catchall !== undefined && catchall._zod.def.type !== 'never') {
        w.out.push({ at: w.at, construct: `.passthrough/.catchall(${catchall._zod.def.type}) (unknown keys kept as-is)` });
      }
      return;
    }
    case 'array':
      next(def.element, `${w.at}[]`);
      return;
    case 'union':
      def.options.forEach((option, i) => next(option, `${w.at}|${i}`));
      return;
    case 'tuple':
      def.items.forEach((item, i) => next(item, `${w.at}[${i}]`));
      if (def.rest) next(def.rest, `${w.at}[...]`);
      return;
    case 'record':
      next(def.keyType, `${w.at}{key}`);
      next(def.valueType, `${w.at}{value}`);
      return;
    case 'optional':
      if (w.root) w.out.push({ at: w.at, construct: 'optional root (the whole input may be absent; the export says a required object)' });
      next(def.innerType, w.at);
      return;
    case 'nullable':
    case 'readonly':
    case 'nonoptional':
    case 'default':
      next(def.innerType, w.at, w.root);
      return;
    case 'pipe':
      next(w.io === 'input' ? def.in : def.out, w.at, w.root);
      return;
    default:
      // string, number, int, boolean, null, literal, enum, never, template_literal: JSON Schema carries them whole.
      return;
  }
}

/** Every construct in `schema` the language-neutral export would erase or cannot express. Empty when it is portable. */
export function portabilityFindings(schema: z.core.$ZodType, io: 'input' | 'output', label: string = io): PortabilityFinding[] {
  const out: PortabilityFinding[] = [];
  walk(schema, { at: label, io, root: true, out });
  return out;
}

/** JSON Schema (draft 2020-12) for `schema`, or `SchemaNotPortableError` naming every construct it would lose. */
export function strictJsonSchema(label: string, schema: z.core.$ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const findings = portabilityFindings(schema, io, label);
  if (findings.length > 0) throw new SchemaNotPortableError(label, findings);
  return z.toJSONSchema(schema, { io, unrepresentable: 'throw' });
}
