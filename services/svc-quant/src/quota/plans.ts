/**
 * Which quota profile a plan gets (AL-limits-01 on the product's one plan concept, the bank's account plan id,
 * BK-acct-04). `QUANT_PLAN_PROFILES_JSON` is the owner's table: `{ "defaultPlanId": "<id>", "profiles": { "<planId>":
 * "<profile>" } }`. An account's plan id is read through a port; while no plan can be read (subscribing is not built),
 * the account is on the default plan. Blank table, blank default or an unmapped plan: no profile applies and every
 * counted write refuses `quant.quota_profile_unset`. An operator's assignment of one account overrides its plan.
 */
export interface PlanProfiles {
  readonly defaultPlanId: string;
  readonly profiles: Readonly<Record<string, string>>;
}

/** The account's plan id, or null when none can be read; null means the default plan. */
export interface PlanPort {
  planOf(accountId: string): Promise<string | null>;
}

/** No plan read is connected yet: every account reads as being on the default plan. */
export const DEFAULT_PLAN_PORT: PlanPort = { planOf: async () => null };

const ID = /^[a-z][a-z0-9_-]{0,39}$/;

export function parsePlanProfiles(raw: string | undefined): PlanProfiles | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('QUANT_PLAN_PROFILES_JSON is not JSON');
  }
  const rec = parsed as { defaultPlanId?: unknown; profiles?: unknown };
  if (typeof rec.defaultPlanId !== 'string' || !ID.test(rec.defaultPlanId)) {
    throw new Error('QUANT_PLAN_PROFILES_JSON needs defaultPlanId, a plan id');
  }
  if (!rec.profiles || typeof rec.profiles !== 'object' || Array.isArray(rec.profiles)) {
    throw new Error('QUANT_PLAN_PROFILES_JSON needs profiles, a plan id to profile name map');
  }
  const profiles: Record<string, string> = {};
  for (const [plan, profile] of Object.entries(rec.profiles as Record<string, unknown>)) {
    if (!ID.test(plan)) throw new Error(`QUANT_PLAN_PROFILES_JSON names a malformed plan id ${plan}`);
    if (typeof profile !== 'string' || !profile.trim() || profile.length > 80) {
      throw new Error(`QUANT_PLAN_PROFILES_JSON plan ${plan} needs a profile name of 1 to 80 characters`);
    }
    profiles[plan] = profile.trim();
  }
  return { defaultPlanId: rec.defaultPlanId, profiles };
}

/** The profile an account's plan maps to, with the plan it read; null when the table is blank or the plan is unmapped. */
export async function planProfileOf(
  plans: PlanProfiles | null,
  port: PlanPort,
  accountId: string,
): Promise<{ readonly plan: string; readonly profile: string } | null> {
  if (!plans) return null;
  let plan: string | null = null;
  try {
    plan = await port.planOf(accountId);
  } catch {
    // An unreadable plan reads as the default plan, never as a bigger one.
    plan = null;
  }
  const id = plan ?? plans.defaultPlanId;
  const profile = plans.profiles[id];
  return profile ? { plan: id, profile } : null;
}
