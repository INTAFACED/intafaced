import 'server-only';
import {
  opsCapitalScenarioSchema,
  opsCapitalSnapshotSchema,
  type OpsCapitalScenario,
  type OpsCapitalScenarioInput,
  type OpsCapitalSnapshot,
} from '@intafaced/contracts/ops-capital';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { CAPITAL_REFUSAL_WORDS } from './model';

const labels = (what: string) => ({
  service: 'svc-ops',
  forbiddenMessage: `svc-ops did not accept this founder session for the ${what}. It needs the operator read permission (admin:read).`,
  refusedMessage: (code: string | null) =>
    code !== null && Object.hasOwn(CAPITAL_REFUSAL_WORDS, code) ? CAPITAL_REFUSAL_WORDS[code]! : null,
});

/** The monitor, evaluated by svc-ops now, as the signed-in founder. A failed read shows no figures. */
export async function readCapital(ctx: FounderCallContext): Promise<Part<OpsCapitalSnapshot>> {
  const result = await founderCall(ctx, 'ops', 'capital.snapshot', 'GET', undefined, parseWith(opsCapitalSnapshotSchema));
  return partFrom(result, (d) => d, labels('capital monitor'));
}

/** One counterparty-default scenario. svc-ops refuses it by name when an input is blank or the ledger cannot be read. */
export async function readScenario(ctx: FounderCallContext, input: OpsCapitalScenarioInput): Promise<Part<OpsCapitalScenario>> {
  const result = await founderCall(ctx, 'ops', 'capital.scenario', 'GET', input, parseWith(opsCapitalScenarioSchema));
  return partFrom(result, (d) => d, labels('scenario'));
}
