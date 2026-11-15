import type { Sql } from 'postgres';
import type { OwnAgentDataClass, OwnAgentRuleChoice } from '@intafaced/contracts/agents-own';

/**
 * This environment's policy overrides (AG-guardrails-02): the layer an operator sets under the owner's managed baseline
 * (`AGENTS_POLICY_BASELINE`) and above each person's own rules. One choice per tool class. The service refuses an
 * override looser than the baseline before it stores it (alerts/routes.ts), and every tool gate takes the stricter of
 * the baseline and the override, so an override only ever narrows.
 */

export interface PolicyOverrideView {
  readonly dataClass: OwnAgentDataClass;
  readonly choice: OwnAgentRuleChoice;
  readonly setBy: string;
  readonly setAt: string;
}

interface OverrideRow {
  data_class: OwnAgentDataClass;
  choice: OwnAgentRuleChoice;
  set_by: string;
  set_at: Date;
}

const view = (row: OverrideRow): PolicyOverrideView => ({
  dataClass: row.data_class,
  choice: row.choice,
  setBy: row.set_by,
  setAt: row.set_at.toISOString(),
});

export class PolicyOverrideStore {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<PolicyOverrideView[]> {
    const rows = await this.sql<OverrideRow[]>`
      SELECT data_class, choice, set_by, set_at FROM agents.agent_policy_overrides ORDER BY data_class
    `;
    return rows.map(view);
  }

  async forClass(dataClass: OwnAgentDataClass): Promise<OwnAgentRuleChoice | null> {
    const rows = await this.sql<{ choice: OwnAgentRuleChoice }[]>`
      SELECT choice FROM agents.agent_policy_overrides WHERE data_class = ${dataClass}
    `;
    return rows[0]?.choice ?? null;
  }

  /** One row per class: setting the same choice again keeps the row as it was; a new choice replaces it. */
  async set(dataClass: OwnAgentDataClass, choice: OwnAgentRuleChoice, setBy: string): Promise<PolicyOverrideView> {
    const rows = await this.sql<OverrideRow[]>`
      INSERT INTO agents.agent_policy_overrides (data_class, choice, set_by)
      VALUES (${dataClass}, ${choice}, ${setBy})
      ON CONFLICT (data_class) DO UPDATE
        SET choice = EXCLUDED.choice,
            set_by = CASE WHEN agent_policy_overrides.choice = EXCLUDED.choice THEN agent_policy_overrides.set_by ELSE EXCLUDED.set_by END,
            set_at = CASE WHEN agent_policy_overrides.choice = EXCLUDED.choice THEN agent_policy_overrides.set_at ELSE now() END
      RETURNING data_class, choice, set_by, set_at
    `;
    return view(rows[0]!);
  }
}
