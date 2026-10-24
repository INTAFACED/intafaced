/**
 * Home's owner values (HM-dashboard-03, HM-navigation-04), answered by the public `home.config` read: how many items
 * the Home work list shows, the order of its kinds, and how many help articles the header search lists.
 *
 * Each value is published by the owner in env. Blank is `null` in the answer, and the customer app refuses with that
 * value's own code (`home.work_list_cap_unset`, `home.work_list_order_unset`, `home.search_result_cap_unset`). Nothing
 * here invents a cap or an order. A malformed value refuses at boot, so a typo never reads as blank.
 */
import { homeConfigOutputSchema, workItemKindSchema, type HomeConfig } from '@intafaced/contracts';

export interface HomeConfigEnv {
  readonly OPS_HOME_WORK_LIST_CAP?: string | undefined;
  readonly OPS_HOME_WORK_LIST_ORDER?: string | undefined;
  readonly OPS_HOME_SEARCH_RESULT_CAP?: string | undefined;
}

const blank = (value: string | undefined) => value === undefined || value.trim() === '';

function wholeNumber(name: string, value: string | undefined): number | null {
  if (blank(value)) return null;
  const text = value!.trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number, or blank while the owner has not set it.`);
  return Number(text);
}

function kinds(value: string | undefined): HomeConfig['workListOrder'] {
  if (blank(value)) return null;
  const list = value!
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean);
  for (const kind of list) {
    if (!workItemKindSchema.safeParse(kind).success) {
      throw new Error(`OPS_HOME_WORK_LIST_ORDER names "${kind}", which is not a work item kind.`);
    }
  }
  return list as NonNullable<HomeConfig['workListOrder']>;
}

/** The answer of `home.config`, built once at boot. Throws on a malformed value; blank stays `null`. */
export function homeConfigFrom(env: HomeConfigEnv): HomeConfig {
  const parsed = homeConfigOutputSchema.safeParse({
    workListCap: wholeNumber('OPS_HOME_WORK_LIST_CAP', env.OPS_HOME_WORK_LIST_CAP),
    workListOrder: kinds(env.OPS_HOME_WORK_LIST_ORDER),
    searchResultCap: wholeNumber('OPS_HOME_SEARCH_RESULT_CAP', env.OPS_HOME_SEARCH_RESULT_CAP),
    // The values change only with a restart, so one revision covers the life of the process.
    revision: 0,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Home owner values refused: ${issue?.path.join('.') ?? 'value'} ${issue?.message ?? 'is not valid'}.`);
  }
  return parsed.data;
}

/** Every value blank: what `home.config` answers when no owner value is published. */
export const BLANK_HOME_CONFIG: HomeConfig = { workListCap: null, workListOrder: null, searchResultCap: null, revision: 0 };
