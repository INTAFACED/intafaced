/**
 * Home's owner values (HM-dashboard-03, HM-navigation-04), answered by the public `home.config` read: how many work
 * items Home shows, in which order of kinds, and how many help articles the header search lists.
 *
 * Each value is an owner decision with no value yet, so each is blank (`null`) until the owner sets it in this service's
 * environment: `OPS_HOME_WORK_LIST_CAP`, `OPS_HOME_WORK_LIST_ORDER` (kinds, comma separated, each once) and
 * `OPS_HOME_SEARCH_RESULT_CAP`. Blank is answered as blank, never as a default: the customer app refuses the work list
 * (`home.work_list_cap_unset`), keeps the owners' order and says so, or shows the search's Help group as not set.
 *
 * The values are display settings, not secrets, so the read is public (the signed-out header search reads the help cap
 * too). They come from the environment, so `revision` is 0: a value changes only with a restart. A founder settings desk
 * with compare-and-set revisions is a later slice.
 */
import { z } from 'zod';
import { homeConfigOutputSchema, publicProcedure, router, type HomeConfig } from '@intafaced/contracts';

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

const field = homeConfigOutputSchema.shape;

/** Plain decimal digits only (no `0x10`, `1e1` or `2.0`), then the contract's own range. */
const count = (inner: z.ZodType<number, number>) =>
  z.string().trim().regex(/^\d+$/, 'a whole number written in digits').transform(Number).pipe(inner);

/** The work list's kinds in the owner's order, comma separated, checked by the contract's own rule. */
const orderSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((kind) => kind.trim())
      .filter(Boolean),
  )
  .pipe(field.workListOrder.unwrap());

export interface HomeConfigEnv {
  OPS_HOME_WORK_LIST_CAP?: string;
  OPS_HOME_WORK_LIST_ORDER?: string;
  OPS_HOME_SEARCH_RESULT_CAP?: string;
}

/**
 * Home's owner values from the environment. A blank value is `null`; a value that is set but malformed throws at boot,
 * so a misspelt kind or a cap out of range never reaches a customer as a silently different list.
 */
export function homeConfigFromEnv(env: HomeConfigEnv): HomeConfig {
  const parse = <T>(name: keyof HomeConfigEnv, schema: z.ZodType<T>): T | null => {
    const raw = env[name];
    if (blank(raw)) return null;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`${name} is not a valid owner value: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    return parsed.data;
  };
  return homeConfigOutputSchema.parse({
    workListCap: parse('OPS_HOME_WORK_LIST_CAP', count(field.workListCap.unwrap())),
    workListOrder: parse('OPS_HOME_WORK_LIST_ORDER', orderSchema),
    searchResultCap: parse('OPS_HOME_SEARCH_RESULT_CAP', count(field.searchResultCap.unwrap())),
    revision: 0,
  });
}

/** `home.config` (the contract's `HOME_CONFIG_PROCEDURE`): public, read only, blank stays blank. */
export function createHomeConfigRouter(config: HomeConfig) {
  return router({
    config: publicProcedure.output(homeConfigOutputSchema).query(() => config),
  });
}
