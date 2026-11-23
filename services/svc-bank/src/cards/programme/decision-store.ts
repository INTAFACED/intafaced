import type { Sql } from 'postgres';
import { ruleParamsSchema, threeDsPolicySchema, type RuleParams, type ThreeDsPolicy, type TraceStep } from './rules.js';

export interface ActiveRule {
  readonly id: string;
  readonly ruleKey: string;
  readonly version: number;
  readonly name: string;
  readonly params: RuleParams;
}

/**
 * What an authorisation decision reads of the card programme (J-bank-26 #1, #3, #4): the promoted rules and the 3DS
 * policy, and where it writes its trace. A stored value that does not parse is left out, never guessed: a rule that
 * cannot be read declines nothing, and an unreadable 3DS policy reads as no policy.
 */
export class ProgrammeDecisionStore {
  constructor(private readonly sql: Sql) {}

  async activeRules(): Promise<ActiveRule[]> {
    const rows = await this.sql<Array<{ id: string; rule_key: string; version: number; name: string; params: unknown }>>`
      SELECT id, rule_key, version, name, params FROM bank.card_programme_rules WHERE state = 'active' ORDER BY promoted_at, id
    `;
    return rows.flatMap((r) => {
      const params = ruleParamsSchema.safeParse(r.params);
      return params.success ? [{ id: r.id, ruleKey: r.rule_key, version: r.version, name: r.name, params: params.data }] : [];
    });
  }

  async threeDsPolicy(): Promise<ThreeDsPolicy | null> {
    const [row] = await this.sql<Array<{ value: unknown }>>`SELECT value FROM bank.card_programme_settings WHERE key = 'threeds'`;
    if (!row) return null;
    const parsed = threeDsPolicySchema.safeParse(row.value);
    return parsed.success ? parsed.data : null;
  }

  /** Written once beside the decision; a redelivered authorisation keeps the first trace. */
  async recordTrace(authorizationId: string, steps: readonly TraceStep[]): Promise<void> {
    await this.sql`
      INSERT INTO bank.card_authorization_traces (authorization_id, steps)
      VALUES (${authorizationId}, ${this.sql.json(steps as never)})
      ON CONFLICT (authorization_id) DO NOTHING
    `;
  }
}
